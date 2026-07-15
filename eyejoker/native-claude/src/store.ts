import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { DeliveryPlan } from "./final-delivery";
import type {
  ClaudeExecution,
  ConversationSettings,
  EnqueueInput,
  FinalStatus,
  JobRecord,
  JobStatus,
  InteractionRecord,
  InteractiveQuestion,
  OutboundFile,
  PermissionMode,
  RewindOperation,
  SessionBranch,
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
  raw_prompt: number;
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
  delivery_chunks: string | null;
  delivery_files: string | null;
  delivery_cursor: number;
  delivery_message_ids: string | null;
  progress_message_id: string | null;
  progress_text: string | null;
  main_model: string | null;
  subagent_models: string | null;
  created_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
}

interface InteractionRow {
  id: string;
  job_id: string;
  conversation_key: string;
  request_key: string;
  question_json: string;
  discord_message_id: string | null;
  answer: string | null;
  status: "pending" | "answered" | "orphaned";
  created_at: string;
  updated_at: string;
}

function interactionFromRow(row: InteractionRow): InteractionRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    conversationKey: row.conversation_key,
    requestKey: row.request_key,
    question: JSON.parse(row.question_json) as InteractiveQuestion,
    discordMessageId: row.discord_message_id,
    answer: row.answer,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    rawPrompt: row.raw_prompt === 1,
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
    deliveryChunks: row.delivery_chunks ? (JSON.parse(row.delivery_chunks) as string[]) : null,
    deliveryFiles: row.delivery_files ? (JSON.parse(row.delivery_files) as OutboundFile[]) : [],
    deliveryCursor: row.delivery_cursor ?? 0,
    deliveryMessageIds: row.delivery_message_ids ? (JSON.parse(row.delivery_message_ids) as string[]) : [],
    progressMessageId: row.progress_message_id,
    progressText: row.progress_text,
    mainModel: row.main_model,
    subagentModels: row.subagent_models ? (JSON.parse(row.subagent_models) as string[]) : [],
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
      CREATE TABLE IF NOT EXISTS session_branches (
        session_id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL,
        parent_session_id TEXT,
        label TEXT,
        status TEXT NOT NULL CHECK(status IN ('active','archived')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_branches_conversation_idx
        ON session_branches(conversation_key, status, created_at);
      CREATE TABLE IF NOT EXISTS session_checkpoints (
        user_message_id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_checkpoints_conversation_idx
        ON session_checkpoints(conversation_key, created_at);
      CREATE TABLE IF NOT EXISTS rewind_operations (
        id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        checkpoint TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('previewed','applied')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_settings (
        conversation_key TEXT PRIMARY KEY,
        model TEXT,
        permission_mode TEXT,
        effort TEXT,
        fork_next INTEGER NOT NULL DEFAULT 0,
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
      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        request_key TEXT NOT NULL,
        question_json TEXT NOT NULL,
        discord_message_id TEXT,
        answer TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','answered','orphaned')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(job_id, request_key),
        FOREIGN KEY(job_id) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS interactions_pending_idx ON interactions(status, conversation_key);
    `);
    this.db.exec(`
      INSERT OR IGNORE INTO session_branches(session_id,conversation_key,parent_session_id,label,status,created_at)
      SELECT session_id,conversation_key,NULL,'legacy','active',created_at FROM sessions;
    `);
    this.ensureColumn("jobs", "raw_prompt", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "progress_message_id", "TEXT");
    this.ensureColumn("jobs", "progress_text", "TEXT");
    this.ensureColumn("jobs", "main_model", "TEXT");
    this.ensureColumn("jobs", "subagent_models", "TEXT");
    this.ensureColumn("jobs", "delivery_chunks", "TEXT");
    this.ensureColumn("jobs", "delivery_files", "TEXT");
    this.ensureColumn("jobs", "delivery_cursor", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "delivery_message_ids", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private activateSessionBranch(
    conversationKey: string,
    previousSessionId: string,
    nextSessionId: string,
    timestamp: string,
  ): void {
    if (nextSessionId !== previousSessionId) {
      this.db.query("UPDATE session_branches SET status='archived' WHERE conversation_key=?").run(conversationKey);
      this.db
        .query(
          `INSERT INTO session_branches(session_id,conversation_key,parent_session_id,label,status,created_at)
           VALUES(?,?,?,'fork','active',?)
           ON CONFLICT(session_id) DO UPDATE SET status='active'`,
        )
        .run(nextSessionId, conversationKey, previousSessionId, timestamp);
    }
    this.db
      .query("UPDATE sessions SET session_id=?, has_history=1, updated_at=? WHERE conversation_key=?")
      .run(nextSessionId, timestamp, conversationKey);
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
        this.db
          .query(
            "INSERT INTO session_branches(session_id,conversation_key,parent_session_id,label,status,created_at) VALUES(?,?,NULL,NULL,'active',?)",
          )
          .run(sessionId, input.conversationKey, timestamp);
      }
      this.db
        .query(
          `INSERT INTO jobs(
            id,route_id,lock_key,conversation_key,channel_id,thread_id,message_id,author_id,prompt,raw_prompt,
            attachment_paths,status,session_id,created_at,queued_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          input.rawPrompt ? 1 : 0,
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
        `UPDATE jobs SET status='running', attempts=attempts+1, started_at=COALESCE(started_at,?), heartbeat_at=?, pid=NULL
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

  getConversationSettings(conversationKey: string): ConversationSettings {
    const row = this.db
      .query<
        { model: string | null; permission_mode: string | null; effort: string | null; fork_next: number },
        [string]
      >("SELECT model, permission_mode, effort, fork_next FROM conversation_settings WHERE conversation_key=?")
      .get(conversationKey);
    return {
      model: row?.model ?? null,
      permissionMode: (row?.permission_mode as PermissionMode | null | undefined) ?? null,
      effort: (row?.effort as ConversationSettings["effort"] | undefined) ?? null,
      forkNext: row?.fork_next === 1,
    };
  }

  setConversationSetting(
    conversationKey: string,
    field: "model" | "permissionMode" | "effort",
    value: string | null,
  ): ConversationSettings {
    const column = field === "permissionMode" ? "permission_mode" : field;
    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db
        .query("INSERT OR IGNORE INTO conversation_settings(conversation_key, updated_at) VALUES(?,?)")
        .run(conversationKey, timestamp);
      this.db.query(`UPDATE conversation_settings SET ${column}=?, updated_at=? WHERE conversation_key=?`).run(
        value,
        timestamp,
        conversationKey,
      );
    });
    tx();
    return this.getConversationSettings(conversationKey);
  }

  requestFork(conversationKey: string): void {
    const timestamp = now();
    this.db
      .query(
        `INSERT INTO conversation_settings(conversation_key, fork_next, updated_at) VALUES(?,1,?)
         ON CONFLICT(conversation_key) DO UPDATE SET fork_next=1, updated_at=excluded.updated_at`,
      )
      .run(conversationKey, timestamp);
  }

  consumeFork(conversationKey: string): boolean {
    const tx = this.db.transaction(() => {
      const row = this.db
        .query<{ fork_next: number }, [string]>(
          "SELECT fork_next FROM conversation_settings WHERE conversation_key=?",
        )
        .get(conversationKey);
      if (row?.fork_next !== 1) return false;
      this.db
        .query("UPDATE conversation_settings SET fork_next=0, updated_at=? WHERE conversation_key=?")
        .run(now(), conversationKey);
      return true;
    });
    return tx();
  }

  resetSession(conversationKey: string, routeId = "reset"): string {
    const sessionId = crypto.randomUUID();
    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO sessions(conversation_key, route_id, session_id, has_history, created_at, updated_at)
           VALUES(?,?,?,0,?,?)
           ON CONFLICT(conversation_key) DO UPDATE SET session_id=excluded.session_id, has_history=0, updated_at=excluded.updated_at`,
        )
        .run(conversationKey, routeId, sessionId, timestamp, timestamp);
      this.db.query("UPDATE session_branches SET status='archived' WHERE conversation_key=?").run(conversationKey);
      this.db
        .query(
          "INSERT INTO session_branches(session_id,conversation_key,parent_session_id,label,status,created_at) VALUES(?,?,NULL,'reset','active',?)",
        )
        .run(sessionId, conversationKey, timestamp);
    });
    tx();
    return sessionId;
  }

  listSessionBranches(conversationKey: string): SessionBranch[] {
    return this.db
      .query<
        {
          session_id: string;
          conversation_key: string;
          parent_session_id: string | null;
          label: string | null;
          status: "active" | "archived";
          created_at: string;
        },
        [string]
      >("SELECT * FROM session_branches WHERE conversation_key=? ORDER BY created_at DESC")
      .all(conversationKey)
      .map((row) => ({
        sessionId: row.session_id,
        conversationKey: row.conversation_key,
        parentSessionId: row.parent_session_id,
        label: row.label,
        status: row.status,
        createdAt: row.created_at,
      }));
  }

  useSessionBranch(conversationKey: string, sessionPrefix: string): SessionBranch {
    const matches = this.listSessionBranches(conversationKey).filter((branch) => branch.sessionId.startsWith(sessionPrefix));
    if (matches.length !== 1) throw new Error(matches.length === 0 ? "branch 없음" : "branch prefix가 모호함");
    const selected = matches[0]!;
    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db.query("UPDATE session_branches SET status='archived' WHERE conversation_key=?").run(conversationKey);
      this.db.query("UPDATE session_branches SET status='active' WHERE session_id=?").run(selected.sessionId);
      this.db
        .query("UPDATE sessions SET session_id=?, has_history=1, updated_at=? WHERE conversation_key=?")
        .run(selected.sessionId, timestamp, conversationKey);
    });
    tx();
    return { ...selected, status: "active" };
  }

  recordSessionCheckpoint(jobId: string, userMessageId: string): void {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    this.db
      .query(
        `INSERT OR IGNORE INTO session_checkpoints(user_message_id,conversation_key,session_id,job_id,created_at)
         VALUES(?,?,?,?,?)`,
      )
      .run(userMessageId, job.conversationKey, job.sessionId, jobId, now());
  }

  listSessionCheckpoints(conversationKey: string): Array<{
    userMessageId: string;
    sessionId: string;
    jobId: string;
    createdAt: string;
  }> {
    return this.db
      .query<
        { user_message_id: string; session_id: string; job_id: string; created_at: string },
        [string]
      >("SELECT user_message_id,session_id,job_id,created_at FROM session_checkpoints WHERE conversation_key=? ORDER BY created_at DESC LIMIT 20")
      .all(conversationKey)
      .map((row) => ({
        userMessageId: row.user_message_id,
        sessionId: row.session_id,
        jobId: row.job_id,
        createdAt: row.created_at,
      }));
  }

  createRewindOperation(
    conversationKey: string,
    sessionId: string,
    checkpoint: string,
    preview: RewindOperation["preview"],
  ): RewindOperation {
    const id = crypto.randomUUID();
    const timestamp = now();
    this.db
      .query(
        `INSERT INTO rewind_operations(id,conversation_key,session_id,checkpoint,preview_json,status,created_at,updated_at)
         VALUES(?,?,?,?,?,'previewed',?,?)`,
      )
      .run(id, conversationKey, sessionId, checkpoint, JSON.stringify(preview), timestamp, timestamp);
    return this.getRewindOperation(conversationKey, id)!;
  }

  getRewindOperation(conversationKey: string, idOrPrefix: string): RewindOperation | null {
    const rows = this.db
      .query<
        {
          id: string;
          conversation_key: string;
          session_id: string;
          checkpoint: string;
          preview_json: string;
          status: "previewed" | "applied";
          created_at: string;
          updated_at: string;
        },
        [string, string]
      >("SELECT * FROM rewind_operations WHERE conversation_key=? AND id LIKE ? ORDER BY created_at DESC LIMIT 2")
      .all(conversationKey, `${idOrPrefix}%`);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return {
      id: row.id,
      conversationKey: row.conversation_key,
      sessionId: row.session_id,
      checkpoint: row.checkpoint,
      preview: JSON.parse(row.preview_json) as RewindOperation["preview"],
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  markRewindApplied(id: string): boolean {
    return (
      this.db
        .query("UPDATE rewind_operations SET status='applied', updated_at=? WHERE id=? AND status='previewed'")
        .run(now(), id).changes === 1
    );
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

  clearProgress(id: string): void {
    this.db
      .query("UPDATE jobs SET progress_message_id=NULL, progress_text=NULL WHERE id=?")
      .run(id);
  }

  prepareDelivery(
    id: string,
    chunks: string[],
    files: OutboundFile[] = [],
  ): DeliveryPlan & { messageIds: string[]; files: OutboundFile[] } {
    const tx = this.db.transaction(() => {
      const row = this.db
        .query<
          {
            delivery_chunks: string | null;
            delivery_files: string | null;
            delivery_cursor: number | null;
            delivery_message_ids: string | null;
          },
          [string]
        >("SELECT delivery_chunks, delivery_files, delivery_cursor, delivery_message_ids FROM jobs WHERE id=?")
        .get(id);
      if (!row) throw new Error(`unknown job: ${id}`);

      if (!row.delivery_chunks) {
        this.db
          .query(
            "UPDATE jobs SET delivery_chunks=?, delivery_files=?, delivery_cursor=0, delivery_message_ids='[]' WHERE id=?",
          )
          .run(JSON.stringify(chunks), JSON.stringify(files), id);
        return { chunks: [...chunks], files: [...files], cursor: 0, messageIds: [] };
      }

      return {
        chunks: JSON.parse(row.delivery_chunks) as string[],
        files: row.delivery_files ? (JSON.parse(row.delivery_files) as OutboundFile[]) : [],
        cursor: row.delivery_cursor ?? 0,
        messageIds: row.delivery_message_ids ? (JSON.parse(row.delivery_message_ids) as string[]) : [],
      };
    });
    return tx();
  }

  markDeliveryChunk(id: string, index: number, messageId: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db
        .query<{ delivery_cursor: number | null; delivery_message_ids: string | null }, [string]>(
          "SELECT delivery_cursor, delivery_message_ids FROM jobs WHERE id=?",
        )
        .get(id);
      if (!row) throw new Error(`unknown job: ${id}`);
      const cursor = row.delivery_cursor ?? 0;
      if (cursor > index) return;
      if (cursor !== index) throw new Error(`delivery cursor mismatch: expected ${cursor}, got ${index}`);
      const messageIds = row.delivery_message_ids ? (JSON.parse(row.delivery_message_ids) as string[]) : [];
      messageIds[index] = messageId;
      this.db
        .query("UPDATE jobs SET delivery_cursor=?, delivery_message_ids=? WHERE id=?")
        .run(index + 1, JSON.stringify(messageIds), id);
    });
    tx();
  }

  listTerminalProgress(): JobRecord[] {
    return this.db
      .query<JobRow, []>(
        "SELECT * FROM jobs WHERE status IN ('completed','failed','cancelled') AND progress_message_id IS NOT NULL ORDER BY completed_at, id",
      )
      .all()
      .map(fromRow);
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
           heartbeat_at=?, delivery_attempts=0, delivery_after=?, delivery_error=NULL, recovery_reason=NULL,
           delivery_chunks=NULL, delivery_files=NULL, delivery_cursor=0, delivery_message_ids='[]',
           main_model=?, subagent_models=?
           WHERE id=?`,
        )
        .run(
          finalStatus,
          execution.result,
          error,
          execution.sessionId || job.sessionId,
          timestamp,
          timestamp,
          execution.mainModel ?? null,
          JSON.stringify(execution.subagentModels ?? []),
          id,
        );
      this.activateSessionBranch(
        job.conversationKey,
        job.sessionId,
        execution.sessionId || job.sessionId,
        timestamp,
      );
      this.db
        .query("UPDATE session_checkpoints SET session_id=? WHERE job_id=?")
        .run(execution.sessionId || job.sessionId, job.id);
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
      this.activateSessionBranch(
        job.conversationKey,
        job.sessionId,
        execution.sessionId || job.sessionId,
        timestamp,
      );
      this.db
        .query("UPDATE session_checkpoints SET session_id=? WHERE job_id=?")
        .run(execution.sessionId || job.sessionId, job.id);
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
             delivery_attempts=0, delivery_after=?, delivery_error=NULL, pid=NULL, heartbeat_at=?,
             delivery_chunks=NULL, delivery_files=NULL, delivery_cursor=0, delivery_message_ids='[]',
             main_model=?, subagent_models=? WHERE id=?`,
          )
          .run(
            execution.result,
            error,
            execution.sessionId || job.sessionId,
            timestamp,
            timestamp,
            execution.mainModel ?? null,
            JSON.stringify(execution.subagentModels ?? []),
            id,
          );
      }
    });
    tx();
    return { retry: job.attempts < maxAttempts, job: this.getJob(id)! };
  }

  updateQueuedPrompt(messageId: string, prompt: string, attachmentPaths?: string[]): JobRecord | null {
    const changed = attachmentPaths
      ? this.db
          .query("UPDATE jobs SET prompt=?, attachment_paths=?, queued_at=? WHERE message_id=? AND status='queued'")
          .run(prompt, JSON.stringify(attachmentPaths), now(), messageId)
      : this.db
          .query("UPDATE jobs SET prompt=?, queued_at=? WHERE message_id=? AND status='queued'")
          .run(prompt, now(), messageId);
    return changed.changes === 1 ? this.getByMessageId(messageId) : null;
  }

  cancelByMessageId(messageId: string, reason = "source message deleted"): JobRecord | null {
    const timestamp = now();
    const changed = this.db
      .query(
        `UPDATE jobs SET status='cancelled', error=?, pid=NULL, completed_at=?
         WHERE message_id=? AND status IN ('queued','running','delivering')`,
      )
      .run(reason, timestamp, messageId);
    return changed.changes === 1 ? this.getByMessageId(messageId) : null;
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

  beginInteraction(jobId: string, conversationKey: string, question: InteractiveQuestion): InteractionRecord {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ question: question.question, choices: question.choices, kind: question.kind ?? "question" }))
      .digest("hex");
    const requestKey = question.requestId ?? `fingerprint:${fingerprint}`;
    const timestamp = now();
    this.db
      .query(
        `INSERT OR IGNORE INTO interactions(
          id,job_id,conversation_key,request_key,question_json,status,created_at,updated_at
        ) VALUES(?,?,?,?,?,'pending',?,?)`,
      )
      .run(crypto.randomUUID(), jobId, conversationKey, requestKey, JSON.stringify(question), timestamp, timestamp);
    const row = this.db
      .query<InteractionRow, [string, string]>("SELECT * FROM interactions WHERE job_id=? AND request_key=?")
      .get(jobId, requestKey);
    if (!row) throw new Error(`interaction not found after insert: ${jobId}/${requestKey}`);
    return interactionFromRow(row);
  }

  setInteractionMessage(id: string, messageId: string): InteractionRecord {
    this.db
      .query("UPDATE interactions SET discord_message_id=?, updated_at=? WHERE id=?")
      .run(messageId, now(), id);
    const row = this.db.query<InteractionRow, [string]>("SELECT * FROM interactions WHERE id=?").get(id);
    if (!row) throw new Error(`interaction not found: ${id}`);
    return interactionFromRow(row);
  }

  answerInteraction(id: string, answer: string): InteractionRecord {
    this.db
      .query("UPDATE interactions SET answer=?, status='answered', updated_at=? WHERE id=?")
      .run(answer, now(), id);
    const row = this.db.query<InteractionRow, [string]>("SELECT * FROM interactions WHERE id=?").get(id);
    if (!row) throw new Error(`interaction not found: ${id}`);
    return interactionFromRow(row);
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
