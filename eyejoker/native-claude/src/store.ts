import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { DeliveryPlan } from "./final-delivery";
import { markerContinuationPrompt, textAnswerForQuestion } from "./interactive-control";
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
  PullRequestWatchRecord,
  RewindOperation,
  SessionBranch,
  SteeringInputRecord,
  SteeringInputState,
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
  pinned_session: number;
  github_watch_repo: string | null;
  github_watch_number: number | null;
  expected_head_sha: string | null;
  attempts: number;
  started_before: number;
  recovery_reason: string | null;
  continuation_prompt: string | null;
  continuation_session_id: string | null;
  continuation_turn: number;
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
  progress_pending: number;
  workspace_path: string | null;
  session_established_at: string | null;
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

interface PullRequestWatchRow {
  id: string;
  route_id: string;
  lock_key: string;
  conversation_key: string;
  session_id: string;
  channel_id: string;
  thread_id: string | null;
  author_id: string;
  repo: string;
  pr_number: number;
  url: string;
  status: "active" | "completed";
  last_observed_signal: string | null;
  last_wake_signal: string | null;
  active_job_id: string | null;
  wake_count: number;
  expires_at: string;
  completed_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface SteeringInputRow {
  message_id: string;
  job_id: string;
  conversation_key: string;
  content: string;
  sdk_message_id: string;
  original_sdk_message_id: string | null;
  state: SteeringInputState;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function steeringInputFromRow(row: SteeringInputRow): SteeringInputRecord {
  return {
    messageId: row.message_id,
    jobId: row.job_id,
    conversationKey: row.conversation_key,
    content: row.content,
    sdkMessageId: row.sdk_message_id,
    originalSdkMessageId: row.original_sdk_message_id ?? row.sdk_message_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
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

function pullRequestWatchFromRow(row: PullRequestWatchRow): PullRequestWatchRecord {
  return {
    id: row.id,
    routeId: row.route_id,
    lockKey: row.lock_key,
    conversationKey: row.conversation_key,
    sessionId: row.session_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    authorId: row.author_id,
    repo: row.repo,
    number: row.pr_number,
    url: row.url,
    status: row.status,
    lastObservedSignal: row.last_observed_signal,
    lastWakeSignal: row.last_wake_signal,
    activeJobId: row.active_job_id,
    wakeCount: row.wake_count,
    expiresAt: row.expires_at,
    completedReason: row.completed_reason,
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
    pinnedSession: row.pinned_session === 1,
    githubWatchRepo: row.github_watch_repo,
    githubWatchNumber: row.github_watch_number,
    expectedHeadSha: row.expected_head_sha,
    attempts: row.attempts,
    startedBefore: row.started_before === 1,
    recoveryReason: row.recovery_reason,
    continuationPrompt: row.continuation_prompt,
    continuationSessionId: row.continuation_session_id,
    continuationTurn: row.continuation_turn ?? 0,
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
    progressPending: row.progress_pending === 1,
    workspacePath: row.workspace_path,
    sessionEstablishedAt: row.session_established_at,
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
      CREATE TABLE IF NOT EXISTS workspace_cleanup_tombstones (
        workspace_path TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
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
        pinned_session INTEGER NOT NULL DEFAULT 0,
        github_watch_repo TEXT,
        github_watch_number INTEGER,
        expected_head_sha TEXT,
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
        progress_pending INTEGER NOT NULL DEFAULT 0,
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
      CREATE TABLE IF NOT EXISTS steering_inputs (
        message_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        content TEXT NOT NULL,
        sdk_message_id TEXT NOT NULL,
        original_sdk_message_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','accepted','edited','deleted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY(job_id) REFERENCES jobs(id)
      );
      CREATE INDEX IF NOT EXISTS steering_inputs_job_idx ON steering_inputs(job_id, created_at);
      CREATE TABLE IF NOT EXISTS pull_request_watches (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        lock_key TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        repo TEXT NOT NULL COLLATE NOCASE,
        pr_number INTEGER NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','completed')),
        last_observed_signal TEXT,
        last_wake_signal TEXT,
        active_job_id TEXT,
        wake_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        completed_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo, pr_number)
      );
      CREATE INDEX IF NOT EXISTS pull_request_watches_active_idx
        ON pull_request_watches(status, expires_at, updated_at);
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
    this.ensureColumn("jobs", "continuation_prompt", "TEXT");
    this.ensureColumn("jobs", "continuation_session_id", "TEXT");
    this.ensureColumn("jobs", "continuation_turn", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "pinned_session", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("jobs", "github_watch_repo", "TEXT");
    this.ensureColumn("jobs", "github_watch_number", "INTEGER");
    this.ensureColumn("jobs", "expected_head_sha", "TEXT");
    const closeLegacyWatcherJobs = this.db.transaction(() => {
      const malformedActiveWatcher = `
        jobs.status IN ('queued','running','delivering')
        AND jobs.message_id LIKE 'github-watch:%'
        AND (
          jobs.pinned_session<>1 OR
          jobs.github_watch_repo IS NULL OR trim(jobs.github_watch_repo)='' OR
          jobs.github_watch_number IS NULL OR
          jobs.expected_head_sha IS NULL OR trim(jobs.expected_head_sha)=''
        )`;
      this.db
        .query(
          `UPDATE session_branches SET status='archived'
           WHERE status='active' AND EXISTS (
             SELECT 1 FROM jobs
             WHERE ${malformedActiveWatcher}
               AND jobs.conversation_key=session_branches.conversation_key
               AND jobs.session_id=session_branches.session_id
           )`,
        )
        .run();
      const contaminatedPointers = this.db
        .query<{ conversation_key: string; session_id: string }, []>(
          `SELECT DISTINCT sessions.conversation_key, sessions.session_id
           FROM sessions JOIN jobs ON jobs.conversation_key=sessions.conversation_key
           WHERE ${malformedActiveWatcher}
             AND jobs.session_id=sessions.session_id`,
        )
        .all();
      for (const pointer of contaminatedPointers) {
        const quarantineSession = crypto.randomUUID();
        const timestamp = now();
        this.db
          .query(
            `UPDATE sessions
             SET session_id=?, has_history=0, updated_at=?
             WHERE conversation_key=? AND session_id=?`,
          )
          .run(quarantineSession, timestamp, pointer.conversation_key, pointer.session_id);
        this.db
          .query(
            `INSERT INTO session_branches(
               session_id,conversation_key,parent_session_id,label,status,created_at
             ) VALUES(?,?,NULL,'legacy watcher quarantine','active',?)`,
          )
          .run(quarantineSession, pointer.conversation_key, timestamp);
      }
      this.db
        .query(
          `UPDATE jobs
           SET status='cancelled', pid=NULL, delivery_after=NULL,
               error=CASE WHEN error IS NULL OR trim(error)='' THEN 'legacy watcher job missing provenance' ELSE error END,
               completed_at=COALESCE(completed_at, ?)
           WHERE ${malformedActiveWatcher}`,
        )
        .run(now());
    });
    closeLegacyWatcherJobs();
    this.ensureColumn("sessions", "workspace_path", "TEXT");
    this.ensureColumn("session_branches", "workspace_path", "TEXT");
    this.ensureColumn("jobs", "workspace_path", "TEXT");
    this.ensureColumn("jobs", "session_established_at", "TEXT");
    this.ensureColumn("jobs", "progress_pending", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("rewind_operations", "workspace_path", "TEXT");
    this.db.exec(`
      UPDATE session_branches
      SET workspace_path=(
        SELECT sessions.workspace_path FROM sessions
        WHERE sessions.conversation_key=session_branches.conversation_key
          AND sessions.session_id=session_branches.session_id
      )
      WHERE workspace_path IS NULL AND status='active';
    `);
    this.ensureColumn("pull_request_watches", "session_id", "TEXT NOT NULL DEFAULT ''");
    this.db
      .query(
        `UPDATE pull_request_watches
         SET status='completed', completed_reason='legacy-missing-session', active_job_id=NULL, updated_at=?
         WHERE status='active' AND trim(session_id)=''`,
      )
      .run(now());
    this.ensureColumn("steering_inputs", "original_sdk_message_id", "TEXT");
    this.db.exec("UPDATE steering_inputs SET original_sdk_message_id=sdk_message_id WHERE original_sdk_message_id IS NULL");
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
    workspacePath?: string,
  ): void {
    if (nextSessionId !== previousSessionId) {
      this.db.query("UPDATE session_branches SET status='archived' WHERE conversation_key=?").run(conversationKey);
      this.db
        .query(
          `INSERT INTO session_branches(session_id,conversation_key,parent_session_id,label,status,created_at,workspace_path)
           VALUES(?,?,?,'fork','active',?,?)
           ON CONFLICT(session_id) DO UPDATE SET status='active', workspace_path=excluded.workspace_path`,
        )
        .run(nextSessionId, conversationKey, previousSessionId, timestamp, workspacePath ?? null);
    }
    if (workspacePath) {
      this.db
        .query("UPDATE session_branches SET workspace_path=? WHERE session_id=? AND conversation_key=?")
        .run(workspacePath, nextSessionId, conversationKey);
      this.db
        .query(
          "UPDATE sessions SET session_id=?, has_history=1, workspace_path=?, updated_at=? WHERE conversation_key=?",
        )
        .run(nextSessionId, workspacePath, timestamp, conversationKey);
    } else {
      this.db
        .query("UPDATE sessions SET session_id=?, has_history=1, updated_at=? WHERE conversation_key=?")
        .run(nextSessionId, timestamp, conversationKey);
    }
  }

  enqueue(input: EnqueueInput, replacePendingSteeringMessageId?: string): JobRecord {
    if (input.pinnedSession && !input.sessionId?.trim()) {
      throw new Error("pinned session id is required");
    }
    const existing = this.db.query<JobRow, [string]>("SELECT * FROM jobs WHERE message_id = ?").get(input.messageId);
    if (existing) {
      if (replacePendingSteeringMessageId) this.discardPendingSteeringInput(replacePendingSteeringMessageId);
      return fromRow(existing);
    }

    const timestamp = now();
    const session = this.db
      .query<{ session_id: string }, [string]>("SELECT session_id FROM sessions WHERE conversation_key = ?")
      .get(input.conversationKey);
    if (input.sessionId) {
      const branch = this.db
        .query<{ found: number }, [string, string]>(
          "SELECT 1 AS found FROM session_branches WHERE session_id=? AND conversation_key=?",
        )
        .get(input.sessionId, input.conversationKey);
      if (!branch && session?.session_id !== input.sessionId) {
        throw new Error(`pinned session does not belong to conversation: ${input.sessionId}`);
      }
    }
    const sessionId = input.sessionId ?? session?.session_id ?? crypto.randomUUID();
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
            attachment_paths,status,session_id,pinned_session,github_watch_repo,github_watch_number,expected_head_sha,
            progress_pending,created_at,queued_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          jobId,
          input.routeId,
          input.lockKey ?? input.conversationKey,
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
          input.pinnedSession ? 1 : 0,
          input.githubWatchRepo ?? null,
          input.githubWatchNumber ?? null,
          input.expectedHeadSha ?? null,
          input.holdForProgress ? 1 : 0,
          timestamp,
          timestamp,
        );
      if (replacePendingSteeringMessageId) {
        this.db
          .query("DELETE FROM steering_inputs WHERE message_id=? AND state='pending'")
          .run(replacePendingSteeringMessageId);
      }
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
         WHERE q.status='queued' AND q.progress_pending=0
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
         WHERE id=? AND status='queued' AND progress_pending=0`,
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
           ON CONFLICT(conversation_key) DO UPDATE SET session_id=excluded.session_id, has_history=0,
             workspace_path=NULL, updated_at=excluded.updated_at`,
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
          workspace_path: string | null;
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
        workspacePath: row.workspace_path,
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
        .query("UPDATE sessions SET session_id=?, has_history=1, workspace_path=?, updated_at=? WHERE conversation_key=?")
        .run(selected.sessionId, selected.workspacePath ?? null, timestamp, conversationKey);
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
    workspacePath?: string,
  ): RewindOperation {
    const id = crypto.randomUUID();
    const timestamp = now();
    this.db
      .query(
        `INSERT INTO rewind_operations(
           id,conversation_key,session_id,checkpoint,preview_json,status,created_at,updated_at,workspace_path
         ) VALUES(?,?,?,?,?,'previewed',?,?,?)`,
      )
      .run(id, conversationKey, sessionId, checkpoint, JSON.stringify(preview), timestamp, timestamp, workspacePath ?? null);
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
          workspace_path: string | null;
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
      workspacePath: row.workspace_path,
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

  markSessionHistory(conversationKey: string): void {
    this.db
      .query("UPDATE sessions SET has_history=1, updated_at=? WHERE conversation_key=?")
      .run(now(), conversationKey);
  }

  sessionWorkspace(conversationKey: string): string | null {
    const row = this.db
      .query<{ workspace_path: string | null }, [string]>(
        "SELECT workspace_path FROM sessions WHERE conversation_key=?",
      )
      .get(conversationKey);
    return row?.workspace_path ?? null;
  }

  sessionWorkspaceForSession(conversationKey: string, sessionId: string): string | null {
    const row = this.db
      .query<{ workspace_path: string | null }, [string, string]>(
        "SELECT workspace_path FROM session_branches WHERE conversation_key=? AND session_id=?",
      )
      .get(conversationKey, sessionId);
    return row?.workspace_path ?? null;
  }

  establishExecutionSession(id: string, establishedSessionId: string, workspacePath: string): JobRecord {
    if (!establishedSessionId.trim()) throw new Error("established session id is empty");
    const job = this.getJob(id);
    if (!job) throw new Error(`job not found: ${id}`);
    const sourceSessionId = job.continuationSessionId ?? job.sessionId;
    const timestamp = now();
    const tx = this.db.transaction(() => {
      if (job.pinnedSession) {
        if (establishedSessionId === sourceSessionId) {
          this.db
            .query("UPDATE session_branches SET workspace_path=? WHERE conversation_key=? AND session_id=?")
            .run(workspacePath, job.conversationKey, sourceSessionId);
        } else {
          this.db
            .query(
              `INSERT INTO session_branches(
                 session_id,conversation_key,parent_session_id,label,status,created_at,workspace_path
               ) VALUES(?,?,?,'pinned fork','archived',?,?)
               ON CONFLICT(session_id) DO UPDATE SET workspace_path=excluded.workspace_path`,
            )
            .run(establishedSessionId, job.conversationKey, sourceSessionId, timestamp, workspacePath);
        }
      } else {
        this.activateSessionBranch(
          job.conversationKey,
          sourceSessionId,
          establishedSessionId,
          timestamp,
          workspacePath,
        );
      }
      this.db
        .query(
          `UPDATE jobs SET session_id=?,
             continuation_session_id=CASE WHEN continuation_session_id IS NULL THEN NULL ELSE ? END,
             workspace_path=?, session_established_at=?, heartbeat_at=?
           WHERE id=? AND status='running'`,
        )
        .run(establishedSessionId, establishedSessionId, workspacePath, timestamp, timestamp, id);
      this.db
        .query("UPDATE session_checkpoints SET session_id=? WHERE job_id=?")
        .run(establishedSessionId, id);
      this.db
        .query(
          `UPDATE pull_request_watches SET session_id=?, updated_at=?
           WHERE status='active' AND conversation_key=? AND session_id IN (?,?)`,
        )
        .run(establishedSessionId, timestamp, job.conversationKey, sourceSessionId, job.sessionId);
    });
    tx();
    return this.getJob(id)!;
  }

  beginWorkspaceCleanup(path: string): void {
    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO workspace_cleanup_tombstones(workspace_path,created_at) VALUES(?,?)
           ON CONFLICT(workspace_path) DO NOTHING`,
        )
        .run(path, timestamp);
      this.db.query("UPDATE sessions SET workspace_path=NULL, updated_at=? WHERE workspace_path=?").run(timestamp, path);
      this.db.query("UPDATE session_branches SET workspace_path=NULL WHERE workspace_path=?").run(path);
      this.db.query("UPDATE jobs SET workspace_path=NULL WHERE workspace_path=?").run(path);
      this.db.query("UPDATE rewind_operations SET workspace_path=NULL WHERE workspace_path=?").run(path);
    });
    tx();
  }

  finishWorkspaceCleanup(path: string): void {
    this.db.query("DELETE FROM workspace_cleanup_tombstones WHERE workspace_path=?").run(path);
  }

  pendingWorkspaceCleanups(): string[] {
    return this.db
      .query<{ workspace_path: string }, []>(
        "SELECT workspace_path FROM workspace_cleanup_tombstones ORDER BY created_at, workspace_path",
      )
      .all()
      .map((row) => row.workspace_path);
  }

  activeWorkspacePaths(): string[] {
    const rows = this.db
      .query<{ workspace_path: string }, []>(
        `SELECT DISTINCT workspace_path FROM jobs
         WHERE status IN ('queued','running','delivering') AND workspace_path IS NOT NULL
         UNION
         SELECT DISTINCT sessions.workspace_path
         FROM sessions JOIN jobs ON jobs.conversation_key=sessions.conversation_key
         WHERE jobs.status IN ('queued','running','delivering') AND sessions.workspace_path IS NOT NULL`,
      )
      .all();
    return rows.map((row) => row.workspace_path);
  }

  invalidateWorkspacePaths(paths: string[]): number {
    if (paths.length === 0) return 0;
    const placeholders = paths.map(() => "?").join(",");
    const timestamp = now();
    const tx = this.db.transaction(() => {
      const sessions = this.db
        .query(`UPDATE sessions SET workspace_path=NULL, updated_at=? WHERE workspace_path IN (${placeholders})`)
        .run(timestamp, ...paths).changes;
      this.db.query(`UPDATE session_branches SET workspace_path=NULL WHERE workspace_path IN (${placeholders})`).run(...paths);
      this.db.query(`UPDATE jobs SET workspace_path=NULL WHERE workspace_path IN (${placeholders})`).run(...paths);
      this.db.query(`UPDATE rewind_operations SET workspace_path=NULL WHERE workspace_path IN (${placeholders})`).run(...paths);
      return sessions;
    });
    return tx();
  }

  setSessionWorkspace(conversationKey: string, workspacePath: string): void {
    const timestamp = now();
    const tx = this.db.transaction(() => {
      this.db
        .query("UPDATE sessions SET workspace_path=?, updated_at=? WHERE conversation_key=?")
        .run(workspacePath, timestamp, conversationKey);
      this.db
        .query("UPDATE session_branches SET workspace_path=? WHERE conversation_key=? AND status='active'")
        .run(workspacePath, conversationKey);
    });
    tx();
  }

  migrateConversationLocks(resolve: (routeId: string, conversationKey: string) => string | null): {
    jobs: number;
    watches: number;
  } {
    const tx = this.db.transaction(() => {
      let jobs = 0;
      let watches = 0;
      const queued = this.db
        .query<{ id: string; route_id: string; conversation_key: string; lock_key: string }, []>(
          "SELECT id,route_id,conversation_key,lock_key FROM jobs WHERE status='queued'",
        )
        .all();
      for (const row of queued) {
        const target = resolve(row.route_id, row.conversation_key);
        if (!target || target === row.lock_key) continue;
        jobs += this.db.query("UPDATE jobs SET lock_key=? WHERE id=? AND status='queued'").run(target, row.id).changes;
      }
      const activeWatches = this.db
        .query<{ id: string; route_id: string; conversation_key: string; lock_key: string }, []>(
          "SELECT id,route_id,conversation_key,lock_key FROM pull_request_watches WHERE status='active'",
        )
        .all();
      for (const row of activeWatches) {
        const target = resolve(row.route_id, row.conversation_key);
        if (!target || target === row.lock_key) continue;
        watches += this.db
          .query("UPDATE pull_request_watches SET lock_key=?, updated_at=? WHERE id=? AND status='active'")
          .run(target, now(), row.id).changes;
      }
      return { jobs, watches };
    });
    return tx();
  }

  setQueuedLock(id: string, lockKey: string): boolean {
    return this.db.query("UPDATE jobs SET lock_key=? WHERE id=? AND status='queued'").run(lockKey, id).changes === 1;
  }

  setPid(id: string, pid: number): void {
    this.db.query("UPDATE jobs SET pid=?, heartbeat_at=? WHERE id=? AND status='running'").run(pid, now(), id);
  }

  heartbeat(id: string): void {
    this.db.query("UPDATE jobs SET heartbeat_at=? WHERE id=? AND status='running'").run(now(), id);
  }

  setProgress(id: string, progressMessageId: string, progressText: string): boolean {
    return (
      this.db
        .query(
          `UPDATE jobs SET progress_message_id=?, progress_text=?, heartbeat_at=?
           WHERE id=? AND status IN ('queued','running','delivering')`,
        )
        .run(progressMessageId, progressText.slice(0, 4000), now(), id).changes === 1
    );
  }

  acknowledgeQueuedProgress(id: string, progressMessageId: string, progressText: string): boolean {
    return (
      this.db
        .query(
          `UPDATE jobs SET progress_message_id=?, progress_text=?, progress_pending=0, heartbeat_at=?
           WHERE id=? AND status='queued'`,
        )
        .run(progressMessageId, progressText.slice(0, 4000), now(), id).changes === 1
    );
  }

  releaseProgressHold(id: string): boolean {
    return (
      this.db
        .query(
          "UPDATE jobs SET progress_pending=0 WHERE id=? AND status='queued' AND progress_pending=1 AND progress_message_id IS NOT NULL",
        )
        .run(id).changes === 1
    );
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

  stageDelivery(
    id: string,
    execution: ClaudeExecution,
    finalStatus: FinalStatus,
    workspacePath?: string,
  ): JobRecord {
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
           continuation_prompt=NULL, continuation_session_id=NULL, continuation_turn=0,
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
      if (!job.pinnedSession) {
        this.activateSessionBranch(
          job.conversationKey,
          job.sessionId,
          execution.sessionId || job.sessionId,
          timestamp,
          workspacePath,
        );
      }
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

  retryOrFail(
    id: string,
    execution: ClaudeExecution,
    maxAttempts: number,
  ): { retry: boolean; job: JobRecord } {
    const job = this.getJob(id);
    if (!job) throw new Error(`job not found: ${id}`);
    const timestamp = now();
    const error = executionError(execution);
    const tx = this.db.transaction(() => {
      if (job.attempts < maxAttempts) {
        this.db
          .query(
            `UPDATE jobs SET status='queued', started_before=1,
             recovery_reason='previous execution failed', error=?, queued_at=?, pid=NULL WHERE id=?`,
          )
          .run(error, timestamp, id);
      } else {
        this.db
          .query(
            `UPDATE jobs SET status='delivering', final_status='failed', result=?, error=?,
             delivery_attempts=0, delivery_after=?, delivery_error=NULL, pid=NULL, heartbeat_at=?,
             delivery_chunks=NULL, delivery_files=NULL, delivery_cursor=0, delivery_message_ids='[]',
             continuation_prompt=NULL, continuation_session_id=NULL, continuation_turn=0,
             main_model=?, subagent_models=? WHERE id=?`,
          )
          .run(
            execution.result,
            error,
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

  requeueTerminalByMessageId(
    messageId: string,
    reason: string,
    prompt?: string,
    lockKey?: string,
  ): JobRecord | null {
    const timestamp = now();
    const changed = this.db
      .query(
        `UPDATE jobs SET
           status='queued', attempts=0, started_before=0, recovery_reason=?, pid=NULL,
           prompt=COALESCE(?,prompt), lock_key=COALESCE(?,lock_key),
           result=NULL, error=NULL, final_status=NULL, delivery_attempts=0, delivery_after=NULL,
           delivery_error=NULL, delivery_chunks=NULL, delivery_files=NULL, delivery_cursor=0,
           delivery_message_ids='[]', progress_message_id=NULL, progress_text=NULL,
           continuation_prompt=NULL, continuation_session_id=NULL, continuation_turn=0,
           queued_at=?, started_at=NULL, heartbeat_at=NULL, completed_at=NULL
         WHERE message_id=? AND status IN ('failed','cancelled')`,
      )
      .run(reason, prompt ?? null, lockKey ?? null, timestamp, messageId);
    return changed.changes === 1 ? this.getByMessageId(messageId) : null;
  }

  cancelJob(id: string, reason: string): JobRecord | null {
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      const changed = this.db
        .query(
          `UPDATE jobs SET status='cancelled', error=?, pid=NULL, completed_at=?, delivery_after=NULL
           WHERE id=? AND status IN ('queued','running','delivering')`,
        )
        .run(reason, timestamp, id);
      if (changed.changes !== 1) return false;
      this.db
        .query("UPDATE interactions SET status='orphaned', updated_at=? WHERE job_id=? AND status='pending'")
        .run(timestamp, id);
      return true;
    });
    return transaction() ? this.getJob(id) : null;
  }

  cancelByMessageId(messageId: string, reason = "source message deleted"): JobRecord | null {
    const job = this.db
      .query<JobRow, [string]>(
        "SELECT * FROM jobs WHERE message_id=? AND status IN ('queued','running','delivering')",
      )
      .get(messageId);
    if (!job) return null;
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      const changed = this.db
        .query(
          `UPDATE jobs SET status='cancelled', error=?, pid=NULL, completed_at=?
           WHERE id=? AND status IN ('queued','running','delivering')`,
        )
        .run(reason, timestamp, job.id);
      if (changed.changes !== 1) return false;
      this.db
        .query("UPDATE interactions SET status='orphaned', updated_at=? WHERE job_id=? AND status='pending'")
        .run(timestamp, job.id);
      return true;
    });
    return transaction() ? this.getJob(job.id) : null;
  }

  cancelByConversation(conversationKey: string, reason = "cancelled by user"): JobRecord[] {
    const rows = this.db
      .query<JobRow, [string]>(
        "SELECT * FROM jobs WHERE conversation_key=? AND status IN ('queued','running','delivering')",
      )
      .all(conversationKey);
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      this.db
        .query(
          `UPDATE jobs SET status='cancelled', error=?, pid=NULL, completed_at=?, delivery_after=NULL
           WHERE conversation_key=? AND status IN ('queued','running','delivering')`,
        )
        .run(reason, timestamp, conversationKey);
      for (const row of rows) {
        this.db
          .query("UPDATE interactions SET status='orphaned', updated_at=? WHERE job_id=? AND status='pending'")
          .run(timestamp, row.id);
      }
    });
    transaction();
    return rows.map(fromRow);
  }

  beginSteeringInput(input: {
    messageId: string;
    jobId: string;
    conversationKey: string;
    content: string;
    sdkMessageId: string;
  }): SteeringInputRecord {
    const timestamp = now();
    this.db
      .query(
        `INSERT OR IGNORE INTO steering_inputs(
          message_id,job_id,conversation_key,content,sdk_message_id,original_sdk_message_id,state,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,'pending',?,?)`,
      )
      .run(
        input.messageId,
        input.jobId,
        input.conversationKey,
        input.content,
        input.sdkMessageId,
        input.sdkMessageId,
        timestamp,
        timestamp,
      );
    const record = this.getSteeringInput(input.messageId);
    if (!record) throw new Error(`steering input not found after insert: ${input.messageId}`);
    return record;
  }

  acceptSteeringInput(messageId: string): SteeringInputRecord {
    this.db
      .query("UPDATE steering_inputs SET state='accepted', updated_at=? WHERE message_id=? AND state='pending'")
      .run(now(), messageId);
    const record = this.getSteeringInput(messageId);
    if (!record) throw new Error(`steering input not found: ${messageId}`);
    return record;
  }

  prepareSteeringEdit(messageId: string, content: string): SteeringInputRecord | null {
    const changed = this.db
      .query(
        "UPDATE steering_inputs SET content=?, state='edited', updated_at=? WHERE message_id=? AND state!='deleted'",
      )
      .run(content, now(), messageId);
    return changed.changes === 1 ? this.getSteeringInput(messageId) : null;
  }

  prepareSteeringDelete(messageId: string): SteeringInputRecord | null {
    const timestamp = now();
    const changed = this.db
      .query(
        "UPDATE steering_inputs SET state='deleted', updated_at=?, deleted_at=? WHERE message_id=? AND state!='deleted'",
      )
      .run(timestamp, timestamp, messageId);
    return changed.changes === 1 ? this.getSteeringInput(messageId) : null;
  }

  recordSteeringMutation(messageId: string, sdkMessageId: string): SteeringInputRecord | null {
    this.db
      .query("UPDATE steering_inputs SET sdk_message_id=?, updated_at=? WHERE message_id=?")
      .run(sdkMessageId, now(), messageId);
    return this.getSteeringInput(messageId);
  }

  updateSteeringInput(messageId: string, content: string, sdkMessageId: string): SteeringInputRecord | null {
    if (!this.prepareSteeringEdit(messageId, content)) return null;
    return this.recordSteeringMutation(messageId, sdkMessageId);
  }

  deleteSteeringInput(messageId: string, sdkMessageId: string): SteeringInputRecord | null {
    if (!this.prepareSteeringDelete(messageId)) return this.getSteeringInput(messageId);
    return this.recordSteeringMutation(messageId, sdkMessageId);
  }

  discardPendingSteeringInput(messageId: string): boolean {
    const result = this.db.query("DELETE FROM steering_inputs WHERE message_id=? AND state='pending'").run(messageId);
    return result.changes > 0;
  }

  getSteeringInput(messageId: string): SteeringInputRecord | null {
    const row = this.db
      .query<SteeringInputRow, [string]>("SELECT * FROM steering_inputs WHERE message_id=?")
      .get(messageId);
    return row ? steeringInputFromRow(row) : null;
  }

  listJobSteeringInputs(jobId: string): SteeringInputRecord[] {
    return this.db
      .query<SteeringInputRow, [string]>("SELECT * FROM steering_inputs WHERE job_id=? ORDER BY created_at, rowid")
      .all(jobId)
      .map(steeringInputFromRow);
  }

  listRecoverySteeringInputs(jobId: string): SteeringInputRecord[] {
    return this.listJobSteeringInputs(jobId);
  }

  listPendingSteeringInputs(jobId: string): SteeringInputRecord[] {
    return this.db
      .query<SteeringInputRow, [string]>(
        "SELECT * FROM steering_inputs WHERE job_id=? AND state='pending' ORDER BY created_at, rowid",
      )
      .all(jobId)
      .map(steeringInputFromRow);
  }

  acceptPendingSteeringInputs(jobId: string): number {
    const result = this.db
      .query("UPDATE steering_inputs SET state='accepted', updated_at=? WHERE job_id=? AND state='pending'")
      .run(now(), jobId);
    return result.changes;
  }

  stageContinuation(jobId: string, prompt: string, sessionId: string, turn: number): JobRecord {
    this.db
      .query(
        "UPDATE jobs SET continuation_prompt=?, continuation_session_id=?, continuation_turn=?, heartbeat_at=? WHERE id=?",
      )
      .run(prompt, sessionId, turn, now(), jobId);
    const job = this.getJob(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    return job;
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

  clearInteractionMessage(id: string): InteractionRecord | null {
    this.db
      .query("UPDATE interactions SET discord_message_id=NULL, updated_at=? WHERE id=?")
      .run(now(), id);
    return this.getInteraction(id);
  }

  answerInteraction(id: string, answer: string): InteractionRecord {
    const answered = this.tryAnswerInteraction(id, answer);
    if (answered) return answered;
    const existing = this.getInteraction(id);
    if (!existing) throw new Error(`interaction not found: ${id}`);
    if (existing.status === "answered" && existing.answer === answer) return existing;
    throw new Error(`interaction is not pending: ${id}/${existing.status}`);
  }

  tryAnswerInteraction(id: string, answer: string): InteractionRecord | null {
    const transaction = this.db.transaction(() => {
      const row = this.db
        .query<InteractionRow, [string]>(
          `SELECT i.* FROM interactions i JOIN jobs j ON j.id=i.job_id
           WHERE i.id=? AND i.status='pending' AND j.status='running'`,
        )
        .get(id);
      if (!row) return false;
      const timestamp = now();
      const changed = this.db
        .query("UPDATE interactions SET answer=?, status='answered', updated_at=? WHERE id=? AND status='pending'")
        .run(answer, timestamp, id);
      if (changed.changes !== 1) return false;
      const question = JSON.parse(row.question_json) as InteractiveQuestion;
      if (question.continuation) {
        this.db
          .query(
            "UPDATE jobs SET continuation_prompt=?, continuation_session_id=?, continuation_turn=?, heartbeat_at=? WHERE id=?",
          )
          .run(
            markerContinuationPrompt(question, answer),
            question.continuation.sessionId,
            question.continuation.turn,
            timestamp,
            row.job_id,
          );
      }
      return true;
    });
    if (!transaction()) return null;
    return this.getInteraction(id);
  }

  getInteraction(id: string): InteractionRecord | null {
    const row = this.db.query<InteractionRow, [string]>("SELECT * FROM interactions WHERE id=?").get(id);
    return row ? interactionFromRow(row) : null;
  }

  listJobInteractions(jobId: string): InteractionRecord[] {
    return this.db
      .query<InteractionRow, [string]>("SELECT * FROM interactions WHERE job_id=? ORDER BY created_at, id")
      .all(jobId)
      .map(interactionFromRow);
  }

  pendingInteractionForJob(jobId: string): InteractionRecord | null {
    const row = this.db
      .query<InteractionRow, [string]>(
        "SELECT * FROM interactions WHERE job_id=? AND status='pending' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(jobId);
    return row ? interactionFromRow(row) : null;
  }

  reconcilePendingInteractionSteering(): number {
    const pending = this.db
      .query<InteractionRow, []>(
        `SELECT i.* FROM interactions i JOIN jobs j ON j.id=i.job_id
         WHERE i.status='pending' AND j.status IN ('queued','running')
         ORDER BY i.created_at, i.rowid`,
      )
      .all();
    const transaction = this.db.transaction(() => {
      let reconciled = 0;
      for (const interaction of pending) {
        const steering = this.db
          .query<SteeringInputRow, [string, string]>(
            `SELECT * FROM steering_inputs
             WHERE job_id=? AND state IN ('accepted','edited') AND created_at>=?
             ORDER BY created_at, rowid LIMIT 1`,
          )
          .get(interaction.job_id, interaction.created_at);
        if (!steering) continue;
        const question = JSON.parse(interaction.question_json) as InteractiveQuestion;
        if (question.kind === "permission") continue;
        const answer = textAnswerForQuestion(question, steering.content);
        if (!answer) continue;
        const timestamp = now();
        const changed = this.db
          .query("UPDATE interactions SET answer=?, status='answered', updated_at=? WHERE id=? AND status='pending'")
          .run(answer, timestamp, interaction.id);
        if (changed.changes !== 1) continue;
        if (question.continuation) {
          this.db
            .query(
              "UPDATE jobs SET continuation_prompt=?, continuation_session_id=?, continuation_turn=?, heartbeat_at=? WHERE id=?",
            )
            .run(
              markerContinuationPrompt(question, answer),
              question.continuation.sessionId,
              question.continuation.turn,
              timestamp,
              interaction.job_id,
            );
        }
        this.db.query("DELETE FROM steering_inputs WHERE message_id=?").run(steering.message_id);
        reconciled += 1;
      }
      return reconciled;
    });
    return transaction();
  }

  listSettledInteractionsWithMessages(): InteractionRecord[] {
    return this.db
      .query<InteractionRow, []>(
        "SELECT * FROM interactions WHERE status IN ('answered','orphaned') AND discord_message_id IS NOT NULL ORDER BY updated_at, id",
      )
      .all()
      .map(interactionFromRow);
  }

  upsertPullRequestWatch(
    job: JobRecord,
    reference: { repo: string; number: number; url: string },
    ttlDays = 14,
  ): PullRequestWatchRecord {
    const timestamp = now();
    const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
    const id = createHash("sha256")
      .update(`${reference.repo.toLowerCase()}#${reference.number}`)
      .digest("hex")
      .slice(0, 24);
    const row = this.db
      .query<PullRequestWatchRow, [
        string, string, string, string, string, string, string | null,
        string, string, number, string, string, string, string,
      ]>(
        `INSERT INTO pull_request_watches(
          id,route_id,lock_key,conversation_key,session_id,channel_id,thread_id,author_id,repo,pr_number,url,
          status,last_observed_signal,last_wake_signal,active_job_id,wake_count,expires_at,completed_reason,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',NULL,NULL,NULL,0,?,NULL,?,?)
        ON CONFLICT(repo,pr_number) DO UPDATE SET
          route_id=excluded.route_id,
          lock_key=excluded.lock_key,
          conversation_key=excluded.conversation_key,
          session_id=excluded.session_id,
          channel_id=excluded.channel_id,
          thread_id=excluded.thread_id,
          author_id=excluded.author_id,
          url=excluded.url,
          last_observed_signal=CASE WHEN pull_request_watches.status='active' THEN pull_request_watches.last_observed_signal ELSE NULL END,
          last_wake_signal=CASE WHEN pull_request_watches.status='active' THEN pull_request_watches.last_wake_signal ELSE NULL END,
          active_job_id=CASE WHEN pull_request_watches.status='active' THEN pull_request_watches.active_job_id ELSE NULL END,
          wake_count=CASE WHEN pull_request_watches.status='active' THEN pull_request_watches.wake_count ELSE 0 END,
          status='active',
          expires_at=excluded.expires_at,
          completed_reason=NULL,
          updated_at=excluded.updated_at
        WHERE pull_request_watches.status<>'active' OR (
          pull_request_watches.conversation_key=excluded.conversation_key AND
          pull_request_watches.session_id=excluded.session_id
        )
        RETURNING *`,
      )
      .get(
        id,
        job.routeId,
        job.lockKey,
        job.conversationKey,
        job.sessionId,
        job.channelId,
        job.threadId,
        job.authorId,
        reference.repo,
        reference.number,
        reference.url,
        expiresAt,
        timestamp,
        timestamp,
      );
    if (!row) {
      throw new Error(`PR watch already owned by another session: ${reference.repo}#${reference.number}`);
    }
    return pullRequestWatchFromRow(row);
  }

  getPullRequestWatch(id: string): PullRequestWatchRecord | null {
    const row = this.db.query<PullRequestWatchRow, [string]>("SELECT * FROM pull_request_watches WHERE id=?").get(id);
    return row ? pullRequestWatchFromRow(row) : null;
  }

  listActivePullRequestWatches(): PullRequestWatchRecord[] {
    return this.db
      .query<PullRequestWatchRow, []>("SELECT * FROM pull_request_watches WHERE status='active' ORDER BY created_at,id")
      .all()
      .map(pullRequestWatchFromRow);
  }

  recordPullRequestObservation(
    id: string,
    signal: string,
    wakeJobId?: string,
    wakeSignal?: string,
  ): PullRequestWatchRecord | null {
    const timestamp = now();
    if (wakeJobId) {
      const actionKey = wakeSignal ?? signal;
      this.db
        .query(
          `UPDATE pull_request_watches SET
             last_observed_signal=?,
             wake_count=wake_count + CASE WHEN last_wake_signal IS ? THEN 0 ELSE 1 END,
             last_wake_signal=?,
             active_job_id=?,
             updated_at=?
           WHERE id=? AND status='active'`,
        )
        .run(signal, actionKey, actionKey, wakeJobId, timestamp, id);
    } else {
      this.db
        .query("UPDATE pull_request_watches SET last_observed_signal=?,updated_at=? WHERE id=? AND status='active'")
        .run(signal, timestamp, id);
    }
    return this.getPullRequestWatch(id);
  }

  completePullRequestWatch(id: string, reason: string): PullRequestWatchRecord | null {
    this.db
      .query(
        `UPDATE pull_request_watches SET status='completed',completed_reason=?,active_job_id=NULL,updated_at=?
         WHERE id=?`,
      )
      .run(reason, now(), id);
    return this.getPullRequestWatch(id);
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
          `SELECT 1 AS found FROM jobs WHERE (status='queued' AND progress_pending=0)
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
