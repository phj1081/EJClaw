import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import type {
  ClaudeExecution,
  EnqueueInput,
  FinalStatus,
  JobRecord,
  JobStatus,
} from "./types";

interface JobRow {
  id: string;
  route_id: string;
  lock_key: string;
  conversation_key: string;
  channel_id: string;
  thread_id: string | null;
  message_id: string;
  author_id: string;
  prompt: string;
  attachment_paths: string;
  status: JobStatus;
  session_id: string;
  attempts: number;
  started_before: number;
  recovery_reason: string | null;
  pid: number | null;
  result: string | null;
  error: string | null;
  final_status: FinalStatus | null;
  delivery_attempts: number;
  delivery_after: string | null;
  delivery_error: string | null;
  progress_message_id: string | null;
  progress_text: string | null;
  created_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function fromRow(row: JobRow): JobRecord {
  return {
    id: row.id,
    routeId: row.route_id,
    lockKey: row.lock_key,
    conversationKey: row.conversation_key,
    channelId: row.channel_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    authorId: row.author_id,
    prompt: row.prompt,
    attachmentPaths: JSON.parse(row.attachment_paths) as string[],
    status: row.status,
    sessionId: row.session_id,
    attempts: row.attempts,
    startedBefore: row.started_before === 1,
    recoveryReason: row.recovery_reason,
    pid: row.pid,
    result: row.result,
    error: row.error,
    finalStatus: row.final_status,
    deliveryAttempts: row.delivery_attempts,
    deliveryAfter: row.delivery_after,
    deliveryError: row.delivery_error,
    progressMessageId: row.progress_message_id,
    progressText: row.progress_text,
    createdAt: row.created_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    completedAt: row.completed_at,
  };
}

function executionError(execution: ClaudeExecution): string {
  return [execution.result, execution.stderr].filter(Boolean).join("\n").slice(0, 8000);
}

export class StateStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        conversation_key TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        has_history INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        lock_key TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        message_id TEXT NOT NULL UNIQUE,
        author_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        attachment_paths TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','delivering','completed','failed','cancelled')),
        session_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        started_before INTEGER NOT NULL DEFAULT 0,
        recovery_reason TEXT,
        pid INTEGER,
        result TEXT,
        error TEXT,
        final_status TEXT CHECK(final_status IS NULL OR final_status IN ('completed','failed')),
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        delivery_after TEXT,
        delivery_error TEXT,
        created_at TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        heartbeat_at TEXT,
        completed_at TEXT,
        FOREIGN KEY(conversation_key) REFERENCES sessions(conversation_key)
      );
      CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS jobs_lock_status_idx ON jobs(lock_key, status);
      CREATE INDEX IF NOT EXISTS jobs_delivery_idx ON jobs(status, delivery_after);
    `);
    this.ensureColumn("jobs", "progress_message_id", "TEXT");
    this.ensureColumn("jobs", "progress_text", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  enqueue(input: EnqueueInput): JobRecord {
    const existing = this.db.query<JobRow, [string]>("SELECT * FROM jobs WHERE message_id = ?").get(input.messageId);
    if (existing) return fromRow(existing);

    const timestamp = now();
    const session = this.db
      .query<{ session_id: string }, [string]>("SELECT session_id FROM sessions WHERE conversation_key = ?")
      .get(input.conversationKey);
    const sessionId = session?.session_id ?? crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const tx = this.db.transaction(() => {
      if (!session) {
        this.db
          .query(
            "INSERT INTO sessions(conversation_key, route_id, session_id, created_at, updated_at) VALUES(?,?,?,?,?)",
          )
          .run(input.conversationKey, input.routeId, sessionId, timestamp, timestamp);
      }
      this.db
        .query(
          `INSERT INTO jobs(
            id,route_id,lock_key,conversation_key,channel_id,thread_id,message_id,author_id,prompt,
            attachment_paths,status,session_id,created_at,queued_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          jobId,
          input.routeId,
          input.lockKey ?? input.routeId,
          input.conversationKey,
          input.channelId,
          input.threadId,
          input.messageId,
          input.authorId,
          input.prompt,
          JSON.stringify(input.attachmentPaths),
          "queued",
          sessionId,
          timestamp,
          timestamp,
        );
    });
    tx();
    return this.getJob(jobId)!;
  }

  claimNext(maxConcurrent: number): JobRecord | null {
    const running = this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM jobs WHERE status='running'").get();
    if ((running?.count ?? 0) >= maxConcurrent) return null;
    const row = this.db
      .query<JobRow, []>(
        `SELECT q.* FROM jobs q
         WHERE q.status='queued'
           AND NOT EXISTS (
             SELECT 1 FROM jobs active WHERE active.status='running' AND active.lock_key=q.lock_key
           )
         ORDER BY q.created_at, q.id LIMIT 1`,
      )
      .get();
    if (!row) return null;
    const timestamp = now();
    const changed = this.db
      .query(
        `UPDATE jobs SET status='running', attempts=attempts+1, started_at=?, heartbeat_at=?, pid=NULL
         WHERE id=? AND status='queued'`,
      )
      .run(timestamp, timestamp, row.id);
    return changed.changes === 1 ? this.getJob(row.id) : null;
  }

  recoverInterrupted(reason: string, maxAttempts = Number.MAX_SAFE_INTEGER): number {
    const rows = this.db.query<JobRow, []>("SELECT * FROM jobs WHERE status='running'").all();
    const timestamp = now();
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        if (row.attempts >= maxAttempts) {
          const result = `⛔ 서비스 재시작 복구 한도(${maxAttempts})를 초과했어.`;
          this.db
            .query(
              `UPDATE jobs SET status='delivering', final_status='failed', result=?, error=?,
               delivery_after=?, delivery_error=NULL, pid=NULL, heartbeat_at=? WHERE id=?`,
            )
            .run(result, `${reason}; retry bound reached`, timestamp, timestamp, row.id);
        } else {
          this.db
            .query(
              `UPDATE jobs SET status='queued', started_before=1, recovery_reason=?, queued_at=?, pid=NULL
               WHERE id=?`,
            )
            .run(reason, timestamp, row.id);
        }
        this.db
          .query("UPDATE sessions SET has_history=1, updated_at=? WHERE conversation_key=?")
          .run(timestamp, row.conversation_key);
      }
    });
    tx();
    return rows.length;
  }

  sessionHasHistory(conversationKey: string): boolean {
    const row = this.db
      .query<{ has_history: number }, [string]>("SELECT has_history FROM sessions WHERE conversation_key=?")
      .get(conversationKey);
    return row?.has_history === 1;
  }

  setPid(id: string, pid: number): void {
    this.db.query("UPDATE jobs SET pid=?, heartbeat_at=? WHERE id=? AND status='running'").run(pid, now(), id);
  }

  heartbeat(id: string): void {
    this.db.query("UPDATE jobs SET heartbeat_at=? WHERE id=? AND status='running'").run(now(), id);
  }

  setProgress(id: string, progressMessageId: string, progressText: string): void {
    this.db
      .query(
        `UPDATE jobs SET progress_message_id=?, progress_text=?, heartbeat_at=?
         WHERE id=? AND status IN ('running','delivering','completed','failed','cancelled')`,
      )
      .run(progressMessageId, progressText.slice(0, 4000), now(), id);
  }

  stageDelivery(id: string, execution: ClaudeExecution, finalStatus: FinalStatus): JobRecord {
    const job = this.getJob(id);
    if (!job) throw new Error(`job not found: ${id}`);
    const timestamp = now();
    const error = finalStatus === "failed" ? executionError(execution) : null;
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `UPDATE jobs SET status='delivering', final_status=?, result=?, error=?, session_id=?, pid=NULL,
           heartbeat_at=?, delivery_attempts=0, delivery_after=?, delivery_error=NULL, recovery_reason=NULL
           WHERE id=?`,
        )
        .run(
          finalStatus,
          execution.result,
          error,
          execution.sessionId || job.sessionId,
          timestamp,
          timestamp,
          id,
        );
      this.db
        .query("UPDATE sessions SET session_id=?, has_history=1, updated_at=? WHERE conversation_key=?")
        .run(execution.sessionId || job.sessionId, timestamp, job.conversationKey);
    });
    tx();
    return this.getJob(id)!;
  }

  listDueDeliveries(limit = 100): JobRecord[] {
    return this.db
      .query<JobRow, [string, number]>(
        `SELECT * FROM jobs WHERE status='delivering' AND (delivery_after IS NULL OR delivery_after<=?)
         ORDER BY created_at, id LIMIT ?`,
      )
      .all(now(), limit)
      .map(fromRow);
  }

  deferDelivery(id: string, error: string, retryMs: number): JobRecord {
    const after = new Date(Date.now() + Math.max(0, retryMs)).toISOString();
    this.db
      .query(
        `UPDATE jobs SET delivery_attempts=delivery_attempts+1, delivery_after=?, delivery_error=?
         WHERE id=? AND status='delivering'`,
      )
      .run(after, error.slice(0, 4000), id);
    return this.getJob(id)!;
  }

  markDelivered(id: string): JobRecord {
    const timestamp = now();
    this.db
      .query(
        `UPDATE jobs SET status=COALESCE(final_status,'completed'), completed_at=?, delivery_after=NULL,
         delivery_error=NULL, pid=NULL WHERE id=? AND status='delivering'`,
      )
      .run(timestamp, id);
    return this.getJob(id)!;
  }

  retryOrFail(id: string, execution: ClaudeExecution, maxAttempts: number): { retry: boolean; job: JobRecord } {
    const job = this.getJob(id);
    if (!job) throw new Error(`job not found: ${id}`);
    const timestamp = now();
    const error = executionError(execution);
    const tx = this.db.transaction(() => {
      this.db
        .query("UPDATE sessions SET session_id=?, has_history=1, updated_at=? WHERE conversation_key=?")
        .run(execution.sessionId || job.sessionId, timestamp, job.conversationKey);
      if (job.attempts < maxAttempts) {
        this.db
          .query(
            `UPDATE jobs SET status='queued', session_id=?, started_before=1,
             recovery_reason='previous execution failed', error=?, queued_at=?, pid=NULL WHERE id=?`,
          )
          .run(execution.sessionId || job.sessionId, error, timestamp, id);
      } else {
        this.db
          .query(
            `UPDATE jobs SET status='delivering', final_status='failed', result=?, error=?, session_id=?,
             delivery_attempts=0, delivery_after=?, delivery_error=NULL, pid=NULL, heartbeat_at=? WHERE id=?`,
          )
          .run(
            execution.result,
            error,
            execution.sessionId || job.sessionId,
            timestamp,
            timestamp,
            id,
          );
      }
    });
    tx();
    return { retry: job.attempts < maxAttempts, job: this.getJob(id)! };
  }

  cancelByConversation(conversationKey: string, reason = "cancelled by user"): JobRecord[] {
    const rows = this.db
      .query<JobRow, [string]>(
        "SELECT * FROM jobs WHERE conversation_key=? AND status IN ('queued','running','delivering')",
      )
      .all(conversationKey);
    const timestamp = now();
    this.db
      .query(
        `UPDATE jobs SET status='cancelled', error=?, pid=NULL, completed_at=?, delivery_after=NULL
         WHERE conversation_key=? AND status IN ('queued','running','delivering')`,
      )
      .run(reason, timestamp, conversationKey);
    return rows.map(fromRow);
  }

  getJob(id: string): JobRecord | null {
    const row = this.db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id=?").get(id);
    return row ? fromRow(row) : null;
  }

  getByMessageId(messageId: string): JobRecord | null {
    const row = this.db.query<JobRow, [string]>("SELECT * FROM jobs WHERE message_id=?").get(messageId);
    return row ? fromRow(row) : null;
  }

  hasQueued(): boolean {
    return Boolean(this.db.query<{ found: number }, []>("SELECT 1 AS found FROM jobs WHERE status='queued' LIMIT 1").get());
  }

  hasRunnable(): boolean {
    return Boolean(
      this.db
        .query<{ found: number }, [string]>(
          `SELECT 1 AS found FROM jobs WHERE status='queued'
           OR (status='delivering' AND (delivery_after IS NULL OR delivery_after<=?)) LIMIT 1`,
        )
        .get(now()),
    );
  }

  listJobs(limit = 100): JobRecord[] {
    return this.db
      .query<JobRow, [number]>("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map(fromRow);
  }

  listActive(): JobRecord[] {
    return this.db
      .query<JobRow, []>("SELECT * FROM jobs WHERE status IN ('queued','running','delivering') ORDER BY created_at")
      .all()
      .map(fromRow);
  }

  close(): void {
    this.db.close();
  }
}
