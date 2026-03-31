import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  DATA_DIR,
  normalizeServiceId,
  REVIEWER_AGENT_TYPE,
  SERVICE_ID,
  SERVICE_SESSION_SCOPE,
  STORE_DIR,
} from './config.js';
import {
  isValidGroupFolder,
  resolveTaskRuntimeIpcPath as resolveTaskRuntimeIpcPathFromGroup,
  resolveServiceTaskSessionsPath as resolveServiceTaskSessionsPathFromGroup,
  resolveTaskSessionsPath as resolveTaskSessionsPathFromGroup,
} from './group-folder.js';
import { logger } from './logger.js';
import { getTaskRuntimeTaskId } from './task-watch-status.js';
import {
  NewMessage,
  AgentType,
  PairedProject,
  PairedRoomRole,
  RoomMode,
  PairedTask,
  PairedTurnOutput,
  PairedWorkspace,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';
import { readJsonFile } from './utils.js';

let db: Database;
type RoomModeSource = 'explicit' | 'inferred';

interface StoredRoomModeRow {
  roomMode: RoomMode;
  source: RoomModeSource;
}

export interface WorkItem {
  id: number;
  group_folder: string;
  chat_jid: string;
  agent_type: AgentType;
  service_id: string;
  status: 'produced' | 'delivery_retry' | 'delivered';
  start_seq: number | null;
  end_seq: number | null;
  result_payload: string;
  delivery_attempts: number;
  delivery_message_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export interface ChannelOwnerLeaseRow {
  chat_jid: string;
  owner_service_id: string;
  reviewer_service_id: string | null;
  arbiter_service_id: string | null;
  activated_at: string | null;
  reason: string | null;
}

export interface ServiceHandoff {
  id: number;
  chat_jid: string;
  group_folder: string;
  source_service_id: string;
  target_service_id: string;
  target_agent_type: AgentType;
  prompt: string;
  status: 'pending' | 'claimed' | 'completed' | 'failed';
  start_seq: number | null;
  end_seq: number | null;
  reason: string | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  last_error: string | null;
}

function backfillMessageSeq(database: Database): void {
  const rows = database
    .prepare(
      `SELECT rowid, seq
       FROM messages
       ORDER BY CASE WHEN seq IS NULL THEN 1 ELSE 0 END, seq, timestamp, rowid`,
    )
    .all() as Array<{ rowid: number; seq: number | null }>;

  if (rows.length === 0) {
    return;
  }

  let nextSeq = 1;
  const assignSeq = database.prepare(
    'UPDATE messages SET seq = ? WHERE rowid = ? AND seq IS NULL',
  );
  const tx = database.transaction(() => {
    for (const row of rows) {
      if (row.seq === null) {
        assignSeq.run(nextSeq, row.rowid);
      }
      nextSeq = Math.max(nextSeq, (row.seq ?? nextSeq) + 1);
    }
  });
  tx();

  const maxSeqRow = database
    .prepare('SELECT MAX(seq) AS maxSeq FROM messages')
    .get() as { maxSeq: number | null };
  const maxSeq = maxSeqRow.maxSeq ?? 0;
  if (maxSeq > 0) {
    database
      .prepare('INSERT OR IGNORE INTO message_sequence (id) VALUES (?)')
      .run(maxSeq);
  }
}

function createSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      seq INTEGER,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE TABLE IF NOT EXISTS message_sequence (
      id INTEGER PRIMARY KEY AUTOINCREMENT
    );

    CREATE TABLE IF NOT EXISTS work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      service_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'produced',
      start_seq INTEGER,
      end_seq INTEGER,
      result_payload TEXT NOT NULL,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_message_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      CHECK (status IN ('produced', 'delivery_retry', 'delivered'))
    );
    CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_work_items_group_agent ON work_items(chat_jid, agent_type, service_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_open
      ON work_items(chat_jid, agent_type, service_id)
      WHERE status IN ('produced', 'delivery_retry');

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      agent_type TEXT,
      ci_provider TEXT,
      ci_metadata TEXT,
      max_duration_ms INTEGER,
      status_message_id TEXT,
      status_started_at TEXT,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'claude-code',
      session_id TEXT NOT NULL,
      PRIMARY KEY (group_folder, agent_type)
    );
    CREATE TABLE IF NOT EXISTS service_sessions (
      group_folder TEXT NOT NULL,
      service_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (group_folder, service_id)
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT NOT NULL,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      agent_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      agent_type TEXT NOT NULL DEFAULT 'claude-code',
      work_dir TEXT,
      PRIMARY KEY (jid, agent_type),
      UNIQUE (folder, agent_type)
    );
    CREATE TABLE IF NOT EXISTS paired_projects (
      chat_jid TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      canonical_work_dir TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paired_tasks (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      owner_service_id TEXT NOT NULL,
      reviewer_service_id TEXT NOT NULL,
      title TEXT,
      source_ref TEXT,
      plan_notes TEXT,
      review_requested_at TEXT,
      round_trip_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      arbiter_verdict TEXT,
      arbiter_requested_at TEXT,
      completion_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (status IN ('active', 'review_ready', 'in_review', 'merge_ready', 'completed', 'arbiter_requested', 'in_arbitration'))
    );
    CREATE INDEX IF NOT EXISTS idx_paired_tasks_chat_status
      ON paired_tasks(chat_jid, status, updated_at);
    CREATE TABLE IF NOT EXISTS paired_workspaces (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      role TEXT NOT NULL,
      workspace_dir TEXT NOT NULL,
      snapshot_source_dir TEXT,
      snapshot_ref TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      snapshot_refreshed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (role IN ('owner', 'reviewer')),
      CHECK (status IN ('ready', 'stale'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_paired_workspaces_task_role
      ON paired_workspaces(task_id, role);
    CREATE TABLE IF NOT EXISTS paired_turn_outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      role TEXT NOT NULL,
      output_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, turn_number, role)
    );
    CREATE INDEX IF NOT EXISTS idx_paired_turn_outputs_task
      ON paired_turn_outputs(task_id, turn_number);
    CREATE TABLE IF NOT EXISTS channel_owner (
      chat_jid TEXT PRIMARY KEY,
      owner_service_id TEXT NOT NULL,
      reviewer_service_id TEXT,
      arbiter_service_id TEXT,
      activated_at TEXT,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS room_settings (
      chat_jid TEXT PRIMARY KEY,
      room_mode TEXT NOT NULL,
      mode_source TEXT NOT NULL DEFAULT 'explicit',
      updated_at TEXT NOT NULL,
      CHECK (room_mode IN ('single', 'tribunal'))
    );
    CREATE TABLE IF NOT EXISTS service_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      source_service_id TEXT NOT NULL,
      target_service_id TEXT NOT NULL,
      target_agent_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      start_seq INTEGER,
      end_seq INTEGER,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      CHECK (status IN ('pending', 'claimed', 'completed', 'failed'))
    );
    CREATE INDEX IF NOT EXISTS idx_service_handoffs_target
      ON service_handoffs(target_service_id, status, created_at);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN agent_type TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN ci_provider TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN ci_metadata TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN max_duration_ms INTEGER`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN status_message_id TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN status_started_at TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN suspended_until TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE room_settings ADD COLUMN mode_source TEXT NOT NULL DEFAULT 'explicit'`,
    );
  } catch {
    /* column already exists */
  }

  database.exec(
    `UPDATE room_settings
     SET mode_source = 'explicit'
     WHERE COALESCE(mode_source, '') NOT IN ('explicit', 'inferred')`,
  );

  database.exec(`
    UPDATE scheduled_tasks
    SET agent_type = COALESCE(
      (
        SELECT CASE WHEN COUNT(*) = 1 THEN MIN(agent_type) ELSE NULL END
        FROM registered_groups
        WHERE jid = scheduled_tasks.chat_jid
          AND folder = scheduled_tasks.group_folder
      ),
      (
        SELECT CASE WHEN COUNT(*) = 1 THEN MIN(agent_type) ELSE NULL END
        FROM registered_groups
        WHERE jid = scheduled_tasks.chat_jid
      ),
      (
        SELECT CASE WHEN COUNT(*) = 1 THEN MIN(agent_type) ELSE NULL END
        FROM registered_groups
        WHERE folder = scheduled_tasks.group_folder
      )
    )
    WHERE agent_type IS NULL;
  `);

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE messages ADD COLUMN seq INTEGER`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE work_items ADD COLUMN service_id TEXT DEFAULT ''`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database
      .prepare(
        `UPDATE work_items
         SET service_id = CASE
           WHEN agent_type = 'codex' THEN ?
           ELSE ?
         END
         WHERE COALESCE(service_id, '') = ''`,
      )
      .run(CODEX_MAIN_SERVICE_ID, CLAUDE_SERVICE_ID);
  } catch {
    /* best effort */
  }

  backfillMessageSeq(database);

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_jid_seq ON messages(chat_jid, seq);
  `);
  database.exec(`DROP INDEX IF EXISTS idx_work_items_group_agent;`);
  database.exec(`DROP INDEX IF EXISTS idx_work_items_open;`);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_group_agent
      ON work_items(chat_jid, agent_type, service_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_open
      ON work_items(chat_jid, agent_type, service_id)
      WHERE status IN ('produced', 'delivery_retry');
  `);

  // Migrate registered_groups to composite keys so Claude/Codex can share a jid/folder.
  const registeredGroupsSql = (
    database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'registered_groups'`,
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  if (
    registeredGroupsSql &&
    !registeredGroupsSql.includes('PRIMARY KEY (jid, agent_type)')
  ) {
    const registeredGroupCols = database
      .prepare('PRAGMA table_info(registered_groups)')
      .all() as Array<{ name: string }>;
    const hasIsMain = registeredGroupCols.some((col) => col.name === 'is_main');
    const hasAgentType = registeredGroupCols.some(
      (col) => col.name === 'agent_type',
    );
    const hasWorkDir = registeredGroupCols.some(
      (col) => col.name === 'work_dir',
    );
    const hasAgentConfig = registeredGroupCols.some(
      (col) => col.name === 'agent_config',
    );
    const hasContainerConfig = registeredGroupCols.some(
      (col) => col.name === 'container_config',
    );

    database.exec(`
      CREATE TABLE registered_groups_new (
        jid TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        agent_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0,
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        work_dir TEXT,
        PRIMARY KEY (jid, agent_type),
        UNIQUE (folder, agent_type)
      );
    `);

    database.exec(`
      INSERT INTO registered_groups_new (
        jid,
        name,
        folder,
        trigger_pattern,
        added_at,
        agent_config,
        requires_trigger,
        is_main,
        agent_type,
        work_dir
      )
      SELECT
        jid,
        name,
        folder,
        trigger_pattern,
        added_at,
        ${
          hasAgentConfig
            ? 'agent_config'
            : hasContainerConfig
              ? 'container_config'
              : 'NULL'
        },
        requires_trigger,
        ${hasIsMain ? 'COALESCE(is_main, 0)' : "CASE WHEN folder = 'main' THEN 1 ELSE 0 END"},
        ${hasAgentType ? "COALESCE(agent_type, 'claude-code')" : "'claude-code'"},
        ${hasWorkDir ? 'work_dir' : 'NULL'}
      FROM registered_groups;
    `);

    database.exec(`
      DROP TABLE registered_groups;
      ALTER TABLE registered_groups_new RENAME TO registered_groups;
    `);
  } else {
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main' AND COALESCE(is_main, 0) = 0`,
    );
  }

  const registeredGroupCols = database
    .prepare('PRAGMA table_info(registered_groups)')
    .all() as Array<{ name: string }>;
  const hasAgentConfig = registeredGroupCols.some(
    (col) => col.name === 'agent_config',
  );
  const hasContainerConfig = registeredGroupCols.some(
    (col) => col.name === 'container_config',
  );
  if (!hasAgentConfig) {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN agent_config TEXT`);
  }
  if (hasContainerConfig) {
    database.exec(
      `UPDATE registered_groups
       SET agent_config = COALESCE(agent_config, container_config)
       WHERE container_config IS NOT NULL`,
    );
  }

  // Migration: drop legacy paired tables and rebuild simplified schema.
  // Old tables (paired_executions, paired_approvals, paired_artifacts, paired_events)
  // are no longer used. paired_tasks is rebuilt with simplified columns.
  const pairedTasksSqlRow = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paired_tasks'`,
    )
    .get() as { sql?: string } | undefined;
  const pairedTasksSql = pairedTasksSqlRow?.sql || '';
  const pairedTasksNeedsRebuild =
    pairedTasksSql &&
    (pairedTasksSql.includes('task_policy') ||
      !pairedTasksSql.includes('round_trip_count'));
  if (pairedTasksNeedsRebuild) {
    database.exec(`DROP TABLE IF EXISTS paired_tasks`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS paired_tasks (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT NOT NULL,
        title TEXT,
        source_ref TEXT,
        plan_notes TEXT,
        review_requested_at TEXT,
        round_trip_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        arbiter_verdict TEXT,
        arbiter_requested_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (status IN ('active', 'review_ready', 'in_review', 'merge_ready', 'completed', 'arbiter_requested', 'in_arbitration'))
      );
      CREATE INDEX IF NOT EXISTS idx_paired_tasks_chat_status
        ON paired_tasks(chat_jid, status, updated_at);
    `);
  }

  // Migration: add arbiter columns to paired_tasks and rebuild CHECK constraint
  // if it doesn't include arbiter statuses
  {
    const ptSqlRow = database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paired_tasks'`,
      )
      .get() as { sql?: string } | undefined;
    const ptSql = ptSqlRow?.sql || '';
    if (ptSql && !ptSql.includes('arbiter_requested')) {
      // CHECK constraint cannot be altered in SQLite — rebuild table
      database.exec(`
        CREATE TABLE paired_tasks_new (
          id TEXT PRIMARY KEY,
          chat_jid TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          owner_service_id TEXT NOT NULL,
          reviewer_service_id TEXT NOT NULL,
          title TEXT,
          source_ref TEXT,
          plan_notes TEXT,
          review_requested_at TEXT,
          round_trip_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          arbiter_verdict TEXT,
          arbiter_requested_at TEXT,
          completion_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (status IN ('active', 'review_ready', 'in_review', 'merge_ready', 'completed', 'arbiter_requested', 'in_arbitration'))
        );
        INSERT INTO paired_tasks_new (
          id, chat_jid, group_folder, owner_service_id, reviewer_service_id,
          title, source_ref, plan_notes, review_requested_at,
          round_trip_count, status, created_at, updated_at
        )
        SELECT
          id, chat_jid, group_folder, owner_service_id, reviewer_service_id,
          title, source_ref, plan_notes, review_requested_at,
          round_trip_count, status, created_at, updated_at
        FROM paired_tasks;
        DROP TABLE paired_tasks;
        ALTER TABLE paired_tasks_new RENAME TO paired_tasks;
        CREATE INDEX IF NOT EXISTS idx_paired_tasks_chat_status
          ON paired_tasks(chat_jid, status, updated_at);
      `);
    }
  }

  // Migration: add arbiter_service_id column to channel_owner if it doesn't exist
  try {
    database.exec(
      `ALTER TABLE channel_owner ADD COLUMN arbiter_service_id TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Migration: add completion_reason column to paired_tasks if it doesn't exist
  try {
    database.exec(`ALTER TABLE paired_tasks ADD COLUMN completion_reason TEXT`);
  } catch {
    /* column already exists */
  }

  // Drop legacy tables that are no longer used
  for (const table of [
    'paired_executions',
    'paired_approvals',
    'paired_artifacts',
    'paired_events',
  ]) {
    database.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  // Rebuild paired_workspaces if it has old schema
  const pairedWsSqlRow = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paired_workspaces'`,
    )
    .get() as { sql?: string } | undefined;
  const pairedWsSql = pairedWsSqlRow?.sql || '';
  if (pairedWsSql && pairedWsSql.includes('snapshot_source_fingerprint')) {
    database.exec(`DROP TABLE IF EXISTS paired_workspaces`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS paired_workspaces (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        workspace_dir TEXT NOT NULL,
        snapshot_source_dir TEXT,
        snapshot_ref TEXT,
        status TEXT NOT NULL DEFAULT 'ready',
        snapshot_refreshed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (role IN ('owner', 'reviewer')),
        CHECK (status IN ('ready', 'stale'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_paired_workspaces_task_role
        ON paired_workspaces(task_id, role);
    `);
  }

  // Rebuild paired_projects if it has old schema
  const pairedProjSqlRow = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paired_projects'`,
    )
    .get() as { sql?: string } | undefined;
  const pairedProjSql = pairedProjSqlRow?.sql || '';
  if (pairedProjSql && pairedProjSql.includes('workspace_topology')) {
    database.exec(`DROP TABLE IF EXISTS paired_projects`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS paired_projects (
        chat_jid TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        canonical_work_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  // Migrate sessions table to composite PK (group_folder, agent_type)
  const sessionCols = database
    .prepare('PRAGMA table_info(sessions)')
    .all() as Array<{ name: string }>;
  if (!sessionCols.some((col) => col.name === 'agent_type')) {
    database.exec(`
      CREATE TABLE sessions_new (
        group_folder TEXT NOT NULL,
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        session_id TEXT NOT NULL,
        PRIMARY KEY (group_folder, agent_type)
      );
    `);
    database
      .prepare(
        `INSERT INTO sessions_new (group_folder, agent_type, session_id)
         SELECT group_folder, ?, session_id FROM sessions`,
      )
      .run('claude-code');
    database.exec(`
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
    `);
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  backfillStoredRoomModes(database);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. Opens an existing database file and runs schema/migrations. */
export function _initTestDatabaseFromFile(dbPath: string): void {
  db = new Database(dbPath);
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  const nextSeq = () => {
    db.prepare('INSERT INTO message_sequence DEFAULT VALUES').run();
    return (
      db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }
    ).id;
  };

  db.transaction(() => {
    const existing = db
      .prepare('SELECT seq FROM messages WHERE id = ? AND chat_jid = ?')
      .get(msg.id, msg.chat_jid) as { seq: number | null } | undefined;
    const seq = existing?.seq ?? nextSeq();
    db.prepare(
      `INSERT INTO messages (
         id, chat_jid, sender, sender_name, content, timestamp, seq, is_from_me, is_bot_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, chat_jid) DO UPDATE SET
         sender = excluded.sender,
         sender_name = excluded.sender_name,
         content = excluded.content,
         timestamp = excluded.timestamp,
         is_from_me = excluded.is_from_me,
         is_bot_message = excluded.is_bot_message`,
    ).run(
      msg.id,
      msg.chat_jid,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      seq,
      msg.is_from_me ? 1 : 0,
      msg.is_bot_message ? 1 : 0,
    );
  })();
}

function normalizeMessageRow(
  row: NewMessage & {
    is_from_me?: boolean | number;
    is_bot_message?: boolean | number;
  },
): NewMessage {
  return {
    ...row,
    is_from_me: !!row.is_from_me,
    is_bot_message: !!row.is_bot_message,
  };
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter legacy prefixed outbound messages as a backstop for rows written
  // before explicit bot flags existed. Self-message filtering is channel-specific
  // and happens in message-runtime so cross-bot collaboration still works.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as Array<
    NewMessage & {
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows.map(normalizeMessageRow), newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter legacy prefixed outbound messages as a backstop for rows written
  // before explicit bot flags existed. Self-message filtering is channel-specific
  // and happens in message-runtime so cross-bot collaboration still works.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const rows = db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as Array<
    NewMessage & {
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;
  return rows.map(normalizeMessageRow);
}

function normalizeSeqCursor(
  cursor: string | number | null | undefined,
): number {
  if (typeof cursor === 'number') {
    return Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  }
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function getLatestMessageSeqAtOrBefore(
  timestamp: string,
  chatJid?: string,
): number {
  if (!timestamp) return 0;
  const row = (
    chatJid
      ? db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) AS maxSeq
           FROM messages
           WHERE chat_jid = ? AND timestamp <= ?`,
          )
          .get(chatJid, timestamp)
      : db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) AS maxSeq
           FROM messages
           WHERE timestamp <= ?`,
          )
          .get(timestamp)
  ) as { maxSeq: number | null };
  return row.maxSeq ?? 0;
}

export function getNewMessagesBySeq(
  jids: string[],
  lastSeqCursor: string | number,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newSeqCursor: string } {
  const sinceSeq = normalizeSeqCursor(lastSeqCursor);
  if (jids.length === 0) {
    return { messages: [], newSeqCursor: String(sinceSeq) };
  }

  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, seq, is_from_me, is_bot_message
    FROM messages
    WHERE seq > ? AND chat_jid IN (${placeholders})
      AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY seq
    LIMIT ?
  `;

  const rows = db
    .prepare(sql)
    .all(sinceSeq, ...jids, `${botPrefix}:%`, limit) as Array<
    NewMessage & {
      seq: number;
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;

  const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : sinceSeq;
  return {
    messages: rows.map(normalizeMessageRow),
    newSeqCursor: String(lastSeq),
  };
}

export function getMessagesSinceSeq(
  chatJid: string,
  sinceSeqCursor: string | number,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  const sinceSeq = normalizeSeqCursor(sinceSeqCursor);
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, seq, is_from_me, is_bot_message
    FROM messages
    WHERE chat_jid = ? AND seq > ?
      AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY seq
    LIMIT ?
  `;
  const rows = db
    .prepare(sql)
    .all(chatJid, sinceSeq, `${botPrefix}:%`, limit) as Array<
    NewMessage & {
      seq: number;
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;
  return rows.map(normalizeMessageRow);
}

/**
 * Get the N most recent messages for a chat, ordered chronologically.
 * Includes both human and bot messages for full conversation context.
 * Used for conversation context retrieval.
 */
export function getRecentChatMessages(
  chatJid: string,
  limit: number = 20,
): NewMessage[] {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
      FROM messages
      WHERE chat_jid = ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const rows = db.prepare(sql).all(chatJid, limit) as Array<
    NewMessage & {
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;
  return rows.map(normalizeMessageRow);
}

export function getLastHumanMessageTimestamp(chatJid: string): string | null {
  const row = db
    .prepare(
      `SELECT timestamp FROM messages
       WHERE chat_jid = ? AND is_bot_message = 0 AND is_from_me = 0
         AND content != '' AND content IS NOT NULL
       ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(chatJid) as { timestamp: string } | undefined;
  return row?.timestamp ?? null;
}

export function getLastHumanMessageSender(chatJid: string): string | null {
  const row = db
    .prepare(
      `SELECT sender FROM messages
       WHERE chat_jid = ? AND is_bot_message = 0 AND is_from_me = 0
         AND content != '' AND content IS NOT NULL
       ORDER BY timestamp DESC, seq DESC LIMIT 1`,
    )
    .get(chatJid) as { sender: string } | undefined;
  return row?.sender ?? null;
}

export function getLastHumanMessageContent(chatJid: string): string | null {
  const row = db
    .prepare(
      `SELECT content FROM messages
       WHERE chat_jid = ? AND is_bot_message = 0 AND is_from_me = 0
         AND content != '' AND content IS NOT NULL
       ORDER BY timestamp DESC, seq DESC LIMIT 1`,
    )
    .get(chatJid) as { content: string } | undefined;
  return row?.content ?? null;
}

export function hasRecentRestartAnnouncement(
  chatJid: string,
  sinceTimestamp: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages
       WHERE chat_jid = ?
         AND timestamp >= ?
         AND is_bot_message = 1
         AND (
           content LIKE '재시작 완료.%'
           OR content LIKE '재시작 감지.%'
           OR content LIKE '서비스 재시작으로 이전 작업이 중단됐습니다.%'
         )
       LIMIT 1`,
    )
    .get(chatJid, sinceTimestamp) as { 1: number } | undefined;
  return !!row;
}

export function getOpenWorkItem(
  chatJid: string,
  agentType: AgentType = 'claude-code',
  serviceId: string = SERVICE_SESSION_SCOPE,
): WorkItem | undefined {
  return db
    .prepare(
      `SELECT *
       FROM work_items
       WHERE chat_jid = ? AND agent_type = ? AND service_id = ?
         AND status IN ('produced', 'delivery_retry')
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get(chatJid, agentType, serviceId) as WorkItem | undefined;
}

export function createProducedWorkItem(input: {
  group_folder: string;
  chat_jid: string;
  agent_type?: AgentType;
  service_id?: string;
  start_seq: number | null;
  end_seq: number | null;
  result_payload: string;
}): WorkItem {
  const now = new Date().toISOString();
  const agentType = input.agent_type || 'claude-code';
  const serviceId = input.service_id || SERVICE_SESSION_SCOPE;
  db.prepare(
    `INSERT INTO work_items (
         group_folder,
         chat_jid,
         agent_type,
         service_id,
         status,
         start_seq,
         end_seq,
         result_payload,
         delivery_attempts,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, 'produced', ?, ?, ?, 0, ?, ?)`,
  ).run(
    input.group_folder,
    input.chat_jid,
    agentType,
    serviceId,
    input.start_seq,
    input.end_seq,
    input.result_payload,
    now,
    now,
  );

  const lastId = (
    db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }
  ).id;
  return db
    .prepare('SELECT * FROM work_items WHERE id = ?')
    .get(lastId) as WorkItem;
}

export function markWorkItemDelivered(
  id: number,
  deliveryMessageId?: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE work_items
     SET status = 'delivered',
         delivered_at = ?,
         delivery_message_id = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(now, deliveryMessageId || null, now, id);
}

export function markWorkItemDeliveryRetry(id: number, error: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE work_items
     SET status = 'delivery_retry',
         delivery_attempts = delivery_attempts + 1,
         last_error = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(error, now, id);
}

export function createTask(
  task: Omit<
    ScheduledTask,
    | 'last_run'
    | 'last_result'
    | 'agent_type'
    | 'ci_provider'
    | 'ci_metadata'
    | 'max_duration_ms'
    | 'status_message_id'
    | 'status_started_at'
  > & {
    agent_type?: AgentType | null;
    ci_provider?: ScheduledTask['ci_provider'];
    ci_metadata?: string | null;
    max_duration_ms?: number | null;
    status_message_id?: string | null;
    status_started_at?: string | null;
  },
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, agent_type, ci_provider, ci_metadata, max_duration_ms, status_message_id, status_started_at, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.agent_type || 'claude-code',
    task.ci_provider ?? null,
    task.ci_metadata ?? null,
    task.max_duration_ms ?? null,
    task.status_message_id || null,
    task.status_started_at || null,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

/**
 * Find an existing active/paused CI watcher for the same channel + provider + metadata.
 * Used to prevent duplicate watchers when both agents register for the same CI run.
 */
export function findDuplicateCiWatcher(
  chatJid: string,
  ciProvider: string,
  ciMetadata: string,
): ScheduledTask | undefined {
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE chat_jid = ? AND ci_provider = ? AND ci_metadata = ?
         AND status IN ('active', 'paused')
       LIMIT 1`,
    )
    .get(chatJid, ciProvider, ciMetadata) as ScheduledTask | undefined;
}

export function getTasksForGroup(
  groupFolder: string,
  agentType?: AgentType,
): ScheduledTask[] {
  if (agentType) {
    return db
      .prepare(
        'SELECT * FROM scheduled_tasks WHERE group_folder = ? AND agent_type = ? ORDER BY created_at DESC',
      )
      .all(groupFolder, agentType) as ScheduledTask[];
  }

  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(agentType?: AgentType): ScheduledTask[] {
  if (agentType) {
    return db
      .prepare(
        'SELECT * FROM scheduled_tasks WHERE agent_type = ? ORDER BY created_at DESC',
      )
      .all(agentType) as ScheduledTask[];
  }

  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'suspended_until'
      | 'ci_metadata'
    >
  >,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.suspended_until !== undefined) {
    fields.push('suspended_until = ?');
    values.push(updates.suspended_until);
  }
  if (updates.ci_metadata !== undefined) {
    fields.push('ci_metadata = ?');
    values.push(updates.ci_metadata);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function updateTaskStatusTracking(
  id: string,
  updates: Partial<
    Pick<ScheduledTask, 'status_message_id' | 'status_started_at'>
  >,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.status_message_id !== undefined) {
    fields.push('status_message_id = ?');
    values.push(updates.status_message_id);
  }
  if (updates.status_started_at !== undefined) {
    fields.push('status_started_at = ?');
    values.push(updates.status_started_at);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  const task = getTaskById(id);
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);

  if (!task) return;

  const runtimeTaskId = getTaskRuntimeTaskId(task);
  if (!runtimeTaskId) return;

  const cleanupTargets = [];
  try {
    cleanupTargets.push(
      resolveTaskRuntimeIpcPathFromGroup(task.group_folder, runtimeTaskId),
      resolveTaskSessionsPathFromGroup(task.group_folder, runtimeTaskId),
      resolveServiceTaskSessionsPathFromGroup(
        task.group_folder,
        CLAUDE_SERVICE_ID,
        runtimeTaskId,
      ),
      resolveServiceTaskSessionsPathFromGroup(
        task.group_folder,
        CODEX_MAIN_SERVICE_ID,
        runtimeTaskId,
      ),
      resolveServiceTaskSessionsPathFromGroup(
        task.group_folder,
        CODEX_REVIEW_SERVICE_ID,
        runtimeTaskId,
      ),
    );
  } catch (err) {
    logger.warn(
      { taskId: id, groupFolder: task.group_folder, err },
      'Failed to resolve task-scoped cleanup paths',
    );
    return;
  }

  for (const cleanupPath of cleanupTargets) {
    try {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { taskId: id, cleanupPath, err },
        'Failed to remove task-scoped runtime artifacts',
      );
    }
  }
}

export function hasActiveCiWatcherForChat(chatJid: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM scheduled_tasks
       WHERE chat_jid = ? AND status = 'active' AND prompt LIKE '[BACKGROUND CI WATCH]%'
       LIMIT 1`,
    )
    .get(chatJid);
  return !!row;
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
      AND (suspended_until IS NULL OR suspended_until <= ?)
    ORDER BY next_run
  `,
    )
    .all(now, now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function getRecentConsecutiveErrors(
  taskId: string,
  limit: number = 5,
): string[] {
  const rows = db
    .prepare(
      `SELECT status, error FROM task_run_logs
       WHERE task_id = ? ORDER BY run_at DESC LIMIT ?`,
    )
    .all(taskId, limit) as Array<{ status: string; error: string | null }>;

  const errors: string[] = [];
  for (const row of rows) {
    if (row.status !== 'error' || !row.error) break;
    errors.push(row.error);
  }
  return errors;
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  return getRouterStateForService(key, SERVICE_ID);
}

export function getRouterStateForService(
  key: string,
  serviceId: string,
): string | undefined {
  const prefixedKey = `${normalizeServiceId(serviceId)}:${key}`;
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(prefixedKey) as { value: string } | undefined;
  if (row) return row.value;

  // Lazy migration: read unprefixed key and migrate to prefixed
  const old = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  if (old) {
    db.prepare(
      'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
    ).run(prefixedKey, old.value);
    db.prepare('DELETE FROM router_state WHERE key = ?').run(key);
    return old.value;
  }
  return undefined;
}

export function setRouterState(key: string, value: string): void {
  setRouterStateForService(key, value, SERVICE_ID);
}

export function setRouterStateForService(
  key: string,
  value: string,
  serviceId: string,
): void {
  const prefixedKey = `${normalizeServiceId(serviceId)}:${key}`;
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(prefixedKey, value);
}

// --- Session accessors ---

export function getSession(
  groupFolder: string,
  agentType: AgentType = 'claude-code',
): string | undefined {
  const serviceScopedRow = db
    .prepare(
      'SELECT session_id FROM service_sessions WHERE group_folder = ? AND service_id = ?',
    )
    .get(groupFolder, SERVICE_SESSION_SCOPE) as
    | { session_id: string }
    | undefined;
  if (serviceScopedRow?.session_id) {
    return serviceScopedRow.session_id;
  }

  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE group_folder = ? AND agent_type = ?',
    )
    .get(groupFolder, agentType) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(
  groupFolder: string,
  sessionId: string,
  agentType: AgentType = 'claude-code',
): void {
  db.prepare(
    'INSERT OR REPLACE INTO service_sessions (group_folder, service_id, session_id) VALUES (?, ?, ?)',
  ).run(groupFolder, SERVICE_SESSION_SCOPE, sessionId);
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, agent_type, session_id) VALUES (?, ?, ?)',
  ).run(groupFolder, agentType, sessionId);
}

export function deleteSession(
  groupFolder: string,
  agentType: AgentType = 'claude-code',
): void {
  db.prepare(
    'DELETE FROM service_sessions WHERE group_folder = ? AND service_id = ?',
  ).run(groupFolder, SERVICE_SESSION_SCOPE);
  db.prepare(
    'DELETE FROM sessions WHERE group_folder = ? AND agent_type = ?',
  ).run(groupFolder, agentType);
}

export function deleteAllSessionsForGroup(groupFolder: string): void {
  db.prepare('DELETE FROM service_sessions WHERE group_folder = ?').run(
    groupFolder,
  );
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const serviceRows = db
    .prepare(
      'SELECT group_folder, session_id FROM service_sessions WHERE service_id = ?',
    )
    .all(SERVICE_SESSION_SCOPE) as Array<{
    group_folder: string;
    session_id: string;
  }>;
  const result: Record<string, string> = {};
  for (const row of serviceRows) {
    result[row.group_folder] = row.session_id;
  }
  if (serviceRows.length > 0) {
    return result;
  }

  const rows = db
    .prepare(
      'SELECT group_folder, session_id FROM sessions WHERE agent_type = ?',
    )
    .all('claude-code') as Array<{
    group_folder: string;
    session_id: string;
  }>;
  const legacyResult: Record<string, string> = {};
  for (const row of rows) {
    legacyResult[row.group_folder] = row.session_id;
  }
  return legacyResult;
}

/**
 * Get session for a specific agent type (cross-provider access).
 * Used for provider switch probe attempts.
 */
export function getSessionForAgentType(
  groupFolder: string,
  agentType: string,
): string | undefined {
  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE group_folder = ? AND agent_type = ?',
    )
    .get(groupFolder, agentType) as { session_id: string } | undefined;
  return row?.session_id;
}

/**
 * Save session for a specific agent type without affecting current service's session.
 * Used when probe succeeds and we want to save to target provider's slot only.
 */
export function setSessionForAgentType(
  groupFolder: string,
  agentType: string,
  sessionId: string,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, agent_type, session_id) VALUES (?, ?, ?)',
  ).run(groupFolder, agentType, sessionId);
}

/**
 * Get the agent type of the most recent bot response in a chat.
 * Used to detect provider switches for delta handoff.
 */
export function getLastRespondingAgentType(
  chatJid: string,
): AgentType | undefined {
  const row = db
    .prepare(
      `SELECT sender FROM messages
       WHERE chat_jid = ? AND is_bot_message = 1
       ORDER BY timestamp DESC, seq DESC
       LIMIT 1`,
    )
    .get(chatJid) as { sender: string } | undefined;

  if (!row) return undefined;

  // Map sender to agent type (sender contains the bot identifier)
  const sender = row.sender.toLowerCase();
  if (sender.includes('claude')) return 'claude-code';
  if (sender.includes('codex')) return 'codex';
  return undefined;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
  agentType?: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = (
    agentType
      ? db
          .prepare(
            'SELECT * FROM registered_groups WHERE jid = ? AND agent_type = ?',
          )
          .get(jid, agentType)
      : db.prepare('SELECT * FROM registered_groups WHERE jid = ?').get(jid)
  ) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        agent_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        agent_type: string | null;
        work_dir: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    agentConfig: row.agent_config ? JSON.parse(row.agent_config) : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    agentType: (row.agent_type as RegisteredGroup['agentType']) || undefined,
    workDir: row.work_dir || undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  const existingRoomMode = getStoredRoomModeRow(jid);
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, agent_config, requires_trigger, is_main, agent_type, work_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.agentConfig ? JSON.stringify(group.agentConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.agentType || 'claude-code',
    group.workDir || null,
  );

  if (!existingRoomMode || existingRoomMode.source === 'inferred') {
    syncInferredRoomModeForJid(jid);
  }
}

export function updateRegisteredGroupName(jid: string, name: string): void {
  db.prepare('UPDATE registered_groups SET name = ? WHERE jid = ?').run(
    name,
    jid,
  );
}

export function getAllRegisteredGroups(
  agentTypeFilter?: string,
): Record<string, RegisteredGroup> {
  const rows = (
    agentTypeFilter
      ? db
          .prepare('SELECT * FROM registered_groups WHERE agent_type = ?')
          .all(agentTypeFilter)
      : db.prepare('SELECT * FROM registered_groups').all()
  ) as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    agent_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    agent_type: string | null;
    work_dir: string | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    const group: RegisteredGroup = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      agentConfig: row.agent_config ? JSON.parse(row.agent_config) : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      agentType: (row.agent_type as RegisteredGroup['agentType']) || undefined,
      workDir: row.work_dir || undefined,
    };
    // In unified mode (no agentTypeFilter), when the same JID has both
    // claude-code and codex rows, prefer the codex entry (owner).
    const existing = result[row.jid];
    if (existing && !agentTypeFilter) {
      if (group.agentType === 'codex') {
        result[row.jid] = group;
      }
      // else keep existing (already codex or first-seen)
    } else {
      result[row.jid] = group;
    }
  }
  return result;
}

function collectRegisteredAgentTypes(
  database: Database,
  jid: string,
): AgentType[] {
  const rows = database
    .prepare('SELECT agent_type FROM registered_groups WHERE jid = ?')
    .all(jid) as Array<{ agent_type: string | null }>;

  const types = new Set<AgentType>();
  for (const row of rows) {
    const agentType = row.agent_type as AgentType | null;
    if (agentType === 'claude-code' || agentType === 'codex') {
      types.add(agentType);
    }
  }
  return [...types];
}

export function getRegisteredAgentTypesForJid(jid: string): AgentType[] {
  if (!db) return [];
  return collectRegisteredAgentTypes(db, jid);
}

export function inferRoomModeFromRegisteredAgentTypes(
  agentTypes: readonly AgentType[],
): RoomMode {
  const types = new Set(agentTypes);
  return types.has('claude-code') && types.has('codex') ? 'tribunal' : 'single';
}

export function inferRoomModeForJid(jid: string): RoomMode {
  return inferRoomModeFromRegisteredAgentTypes(
    getRegisteredAgentTypesForJid(jid),
  );
}

function normalizeRoomModeSource(
  source: string | null | undefined,
): RoomModeSource | undefined {
  return source === 'explicit' || source === 'inferred' ? source : undefined;
}

function getStoredRoomModeRow(chatJid: string): StoredRoomModeRow | undefined {
  if (!db) return undefined;

  const row = db
    .prepare(
      `SELECT room_mode, mode_source
       FROM room_settings
       WHERE chat_jid = ?`,
    )
    .get(chatJid) as
    | { room_mode: string | null; mode_source: string | null }
    | undefined;
  const roomMode =
    row?.room_mode === 'single' || row?.room_mode === 'tribunal'
      ? row.room_mode
      : undefined;
  const source = normalizeRoomModeSource(row?.mode_source);
  return roomMode && source ? { roomMode, source } : undefined;
}

function upsertStoredRoomMode(
  chatJid: string,
  roomMode: RoomMode,
  source: RoomModeSource,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO room_settings (
      chat_jid,
      room_mode,
      mode_source,
      updated_at
    ) VALUES (?, ?, ?, ?)`,
  ).run(chatJid, roomMode, source, new Date().toISOString());
}

function syncInferredRoomModeForJid(chatJid: string): void {
  upsertStoredRoomMode(chatJid, inferRoomModeForJid(chatJid), 'inferred');
}

export function getExplicitRoomMode(chatJid: string): RoomMode | undefined {
  const row = getStoredRoomModeRow(chatJid);
  return row?.source === 'explicit' ? row.roomMode : undefined;
}

export function setExplicitRoomMode(chatJid: string, roomMode: RoomMode): void {
  upsertStoredRoomMode(chatJid, roomMode, 'explicit');
}

export function clearExplicitRoomMode(chatJid: string): void {
  const agentTypes = getRegisteredAgentTypesForJid(chatJid);
  if (agentTypes.length === 0) {
    db.prepare('DELETE FROM room_settings WHERE chat_jid = ?').run(chatJid);
    return;
  }
  upsertStoredRoomMode(
    chatJid,
    inferRoomModeFromRegisteredAgentTypes(agentTypes),
    'inferred',
  );
}

export function getEffectiveRoomMode(chatJid: string): RoomMode {
  return getStoredRoomModeRow(chatJid)?.roomMode ?? 'single';
}

function canRunTribunalFromRegisteredAgentTypes(
  agentTypes: readonly AgentType[],
): boolean {
  const types = new Set(agentTypes);
  if (types.size === 0) return false;
  return REVIEWER_AGENT_TYPE === 'claude-code'
    ? types.has('claude-code')
    : types.has('codex');
}

export function getEffectiveRuntimeRoomMode(chatJid: string): RoomMode {
  return getEffectiveRoomMode(chatJid) === 'tribunal' &&
    canRunTribunalFromRegisteredAgentTypes(
      getRegisteredAgentTypesForJid(chatJid),
    )
    ? 'tribunal'
    : 'single';
}

export function isPairedRoomJid(jid: string): boolean {
  return getEffectiveRuntimeRoomMode(jid) === 'tribunal';
}

function backfillStoredRoomModes(database: Database): void {
  const rows = database
    .prepare(
      `SELECT DISTINCT rg.jid
       FROM registered_groups rg
       LEFT JOIN room_settings rs ON rs.chat_jid = rg.jid
       WHERE rs.chat_jid IS NULL`,
    )
    .all() as Array<{ jid: string }>;
  if (rows.length === 0) return;

  const insertRoomMode = database.prepare(
    `INSERT OR REPLACE INTO room_settings (
      chat_jid,
      room_mode,
      mode_source,
      updated_at
    ) VALUES (?, ?, 'inferred', ?)`,
  );

  const tx = database.transaction((missingRows: Array<{ jid: string }>) => {
    const updatedAt = new Date().toISOString();
    for (const row of missingRows) {
      const roomMode = inferRoomModeFromRegisteredAgentTypes(
        collectRegisteredAgentTypes(database, row.jid),
      );
      insertRoomMode.run(row.jid, roomMode, updatedAt);
    }
  });

  tx(rows);
}

// --- Paired task/project/workspace state ---

export function upsertPairedProject(project: PairedProject): void {
  db.prepare(
    `
      INSERT INTO paired_projects (
        chat_jid,
        group_folder,
        canonical_work_dir,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chat_jid) DO UPDATE SET
        group_folder = excluded.group_folder,
        canonical_work_dir = excluded.canonical_work_dir,
        updated_at = excluded.updated_at
    `,
  ).run(
    project.chat_jid,
    project.group_folder,
    project.canonical_work_dir,
    project.created_at,
    project.updated_at,
  );
}

export function getPairedProject(chatJid: string): PairedProject | undefined {
  return db
    .prepare('SELECT * FROM paired_projects WHERE chat_jid = ?')
    .get(chatJid) as PairedProject | undefined;
}

export function createPairedTask(task: PairedTask): void {
  db.prepare(
    `
      INSERT INTO paired_tasks (
        id,
        chat_jid,
        group_folder,
        owner_service_id,
        reviewer_service_id,
        title,
        source_ref,
        plan_notes,
        review_requested_at,
        round_trip_count,
        status,
        arbiter_verdict,
        arbiter_requested_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    task.id,
    task.chat_jid,
    task.group_folder,
    task.owner_service_id,
    task.reviewer_service_id,
    task.title,
    task.source_ref,
    task.plan_notes,
    task.review_requested_at,
    task.round_trip_count,
    task.status,
    task.arbiter_verdict,
    task.arbiter_requested_at,
    task.created_at,
    task.updated_at,
  );
}

export function getPairedTaskById(id: string): PairedTask | undefined {
  return db.prepare('SELECT * FROM paired_tasks WHERE id = ?').get(id) as
    | PairedTask
    | undefined;
}

export function getLatestPairedTaskForChat(
  chatJid: string,
): PairedTask | undefined {
  return db
    .prepare(
      `
        SELECT *
          FROM paired_tasks
         WHERE chat_jid = ?
         ORDER BY updated_at DESC
         LIMIT 1
      `,
    )
    .get(chatJid) as PairedTask | undefined;
}

export function getLatestOpenPairedTaskForChat(
  chatJid: string,
): PairedTask | undefined {
  return db
    .prepare(
      `
        SELECT *
          FROM paired_tasks
         WHERE chat_jid = ?
           AND status NOT IN ('completed')
         ORDER BY updated_at DESC
         LIMIT 1
      `,
    )
    .get(chatJid) as PairedTask | undefined;
}

export function updatePairedTask(
  id: string,
  updates: Partial<
    Pick<
      PairedTask,
      | 'title'
      | 'source_ref'
      | 'plan_notes'
      | 'review_requested_at'
      | 'round_trip_count'
      | 'status'
      | 'arbiter_verdict'
      | 'arbiter_requested_at'
      | 'completion_reason'
      | 'updated_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.source_ref !== undefined) {
    fields.push('source_ref = ?');
    values.push(updates.source_ref);
  }
  if (updates.plan_notes !== undefined) {
    fields.push('plan_notes = ?');
    values.push(updates.plan_notes);
  }
  if (updates.review_requested_at !== undefined) {
    fields.push('review_requested_at = ?');
    values.push(updates.review_requested_at);
  }
  if (updates.round_trip_count !== undefined) {
    fields.push('round_trip_count = ?');
    values.push(updates.round_trip_count);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.arbiter_verdict !== undefined) {
    fields.push('arbiter_verdict = ?');
    values.push(updates.arbiter_verdict);
  }
  if (updates.arbiter_requested_at !== undefined) {
    fields.push('arbiter_requested_at = ?');
    values.push(updates.arbiter_requested_at);
  }
  if (updates.completion_reason !== undefined) {
    fields.push('completion_reason = ?');
    values.push(updates.completion_reason);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE paired_tasks SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function upsertPairedWorkspace(workspace: PairedWorkspace): void {
  db.prepare(
    `
      INSERT INTO paired_workspaces (
        id,
        task_id,
        role,
        workspace_dir,
        snapshot_source_dir,
        snapshot_ref,
        status,
        snapshot_refreshed_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_dir = excluded.workspace_dir,
        snapshot_source_dir = excluded.snapshot_source_dir,
        snapshot_ref = excluded.snapshot_ref,
        status = excluded.status,
        snapshot_refreshed_at = excluded.snapshot_refreshed_at,
        updated_at = excluded.updated_at
    `,
  ).run(
    workspace.id,
    workspace.task_id,
    workspace.role,
    workspace.workspace_dir,
    workspace.snapshot_source_dir,
    workspace.snapshot_ref,
    workspace.status,
    workspace.snapshot_refreshed_at,
    workspace.created_at,
    workspace.updated_at,
  );
}

export function getPairedWorkspace(
  taskId: string,
  role: PairedWorkspace['role'],
): PairedWorkspace | undefined {
  return db
    .prepare('SELECT * FROM paired_workspaces WHERE task_id = ? AND role = ?')
    .get(taskId, role) as PairedWorkspace | undefined;
}

export function listPairedWorkspacesForTask(taskId: string): PairedWorkspace[] {
  return db
    .prepare(
      'SELECT * FROM paired_workspaces WHERE task_id = ? ORDER BY created_at',
    )
    .all(taskId) as PairedWorkspace[];
}

/**
 * Get the most recent bot message (is_bot_message=1) in a chat, regardless of which bot sent it.
 * Used for duplicate detection in pair rooms.
 */
export function getLastBotFinalMessage(
  chatJid: string,
  _agentType: AgentType = 'claude-code',
  limit: number = 1,
): Array<{ content: string; timestamp: string }> {
  const rows = db
    .prepare(
      `SELECT content, timestamp
       FROM messages
       WHERE chat_jid = ? AND is_bot_message = 1
       ORDER BY timestamp DESC, seq DESC
       LIMIT ?`,
    )
    .all(chatJid, limit) as Array<{ content: string; timestamp: string }>;
  return rows;
}

// --- Channel owner lease accessors ---

export function getChannelOwnerLease(
  chatJid: string,
): ChannelOwnerLeaseRow | undefined {
  return db
    .prepare(
      `SELECT chat_jid, owner_service_id, reviewer_service_id, arbiter_service_id, activated_at, reason
       FROM channel_owner
       WHERE chat_jid = ?`,
    )
    .get(chatJid) as ChannelOwnerLeaseRow | undefined;
}

export function getAllChannelOwnerLeases(): ChannelOwnerLeaseRow[] {
  return db
    .prepare(
      `SELECT chat_jid, owner_service_id, reviewer_service_id, arbiter_service_id, activated_at, reason
       FROM channel_owner`,
    )
    .all() as ChannelOwnerLeaseRow[];
}

export function setChannelOwnerLease(input: {
  chat_jid: string;
  owner_service_id: string;
  reviewer_service_id?: string | null;
  arbiter_service_id?: string | null;
  activated_at?: string | null;
  reason?: string | null;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO channel_owner (
      chat_jid,
      owner_service_id,
      reviewer_service_id,
      arbiter_service_id,
      activated_at,
      reason
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.chat_jid,
    input.owner_service_id,
    input.reviewer_service_id ?? null,
    input.arbiter_service_id ?? null,
    input.activated_at ?? new Date().toISOString(),
    input.reason ?? null,
  );
}

export function clearChannelOwnerLease(chatJid: string): void {
  db.prepare('DELETE FROM channel_owner WHERE chat_jid = ?').run(chatJid);
}

// --- Cross-service handoff accessors ---

export function createServiceHandoff(input: {
  chat_jid: string;
  group_folder: string;
  source_service_id: string;
  target_service_id: string;
  target_agent_type: AgentType;
  prompt: string;
  start_seq?: number | null;
  end_seq?: number | null;
  reason?: string | null;
}): ServiceHandoff {
  db.prepare(
    `INSERT INTO service_handoffs (
        chat_jid,
        group_folder,
        source_service_id,
        target_service_id,
        target_agent_type,
        prompt,
        start_seq,
        end_seq,
        reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.chat_jid,
    input.group_folder,
    input.source_service_id,
    input.target_service_id,
    input.target_agent_type,
    input.prompt,
    input.start_seq ?? null,
    input.end_seq ?? null,
    input.reason ?? null,
  );

  const lastId = (
    db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }
  ).id;
  return db
    .prepare('SELECT * FROM service_handoffs WHERE id = ?')
    .get(lastId) as ServiceHandoff;
}

export function getPendingServiceHandoffs(
  targetServiceId: string = SERVICE_SESSION_SCOPE,
): ServiceHandoff[] {
  return db
    .prepare(
      `SELECT *
       FROM service_handoffs
       WHERE target_service_id = ?
         AND status = 'pending'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(targetServiceId) as ServiceHandoff[];
}

export function claimServiceHandoff(id: number): boolean {
  db.prepare(
    `UPDATE service_handoffs
       SET status = 'claimed',
           claimed_at = datetime('now')
       WHERE id = ?
         AND status = 'pending'`,
  ).run(id);
  return (db.prepare('SELECT changes() as c').get() as { c: number }).c > 0;
}

export function completeServiceHandoff(id: number): void {
  db.prepare(
    `UPDATE service_handoffs
     SET status = 'completed',
         completed_at = datetime('now'),
         last_error = NULL
     WHERE id = ?`,
  ).run(id);
}

export function failServiceHandoff(id: number, error: string): void {
  db.prepare(
    `UPDATE service_handoffs
     SET status = 'failed',
         completed_at = datetime('now'),
         last_error = ?
     WHERE id = ?`,
  ).run(error, id);
}

function normalizeStoredLastAgentSeqCursor(
  cursor: string | number | null | undefined,
  chatJid: string,
): number {
  if (typeof cursor === 'number') {
    return Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  }
  if (!cursor) return 0;
  const trimmed = cursor.trim();
  if (/^\d+$/.test(trimmed)) {
    return normalizeSeqCursor(trimmed);
  }
  return getLatestMessageSeqAtOrBefore(trimmed, chatJid);
}

function parseLastAgentSeqState(
  raw: string | undefined,
  serviceId: string,
): Record<string, string> {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid last_agent_seq JSON for ${serviceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid last_agent_seq JSON for ${serviceId}: not an object`,
    );
  }

  const cursors: Record<string, string> = {};
  for (const [chatJid, cursor] of Object.entries(parsed)) {
    if (typeof cursor === 'string' || typeof cursor === 'number') {
      cursors[chatJid] = String(cursor);
    }
  }
  return cursors;
}

export function completeServiceHandoffAndAdvanceTargetCursor(input: {
  id: number;
  target_service_id: string;
  chat_jid: string;
  end_seq?: number | null;
}): string | null {
  return db.transaction(() => {
    let appliedCursor: string | null = null;

    if (input.end_seq != null) {
      const currentState = parseLastAgentSeqState(
        getRouterStateForService('last_agent_seq', input.target_service_id),
        input.target_service_id,
      );
      const existingSeq = normalizeStoredLastAgentSeqCursor(
        currentState[input.chat_jid],
        input.chat_jid,
      );
      currentState[input.chat_jid] = String(
        Math.max(existingSeq, input.end_seq),
      );
      setRouterStateForService(
        'last_agent_seq',
        JSON.stringify(currentState),
        input.target_service_id,
      );
      appliedCursor = currentState[input.chat_jid];
    }

    db.prepare(
      `UPDATE service_handoffs
       SET status = 'completed',
           completed_at = datetime('now'),
           last_error = NULL
       WHERE id = ?`,
    ).run(input.id);

    return appliedCursor;
  })();
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    const data = readJsonFile(filePath);
    if (data === null) return null;
    try {
      fs.renameSync(filePath, `${filePath}.migrated`);
    } catch {
      /* best effort */
    }
    return data;
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// ── Paired turn outputs ──────────────────────────────────────────

const MAX_TURN_OUTPUT_CHARS = 50_000;

export function insertPairedTurnOutput(
  taskId: string,
  turnNumber: number,
  role: PairedRoomRole,
  outputText: string,
): void {
  if (outputText.length > MAX_TURN_OUTPUT_CHARS) {
    logger.warn(
      {
        taskId,
        turnNumber,
        role,
        originalLen: outputText.length,
        maxLen: MAX_TURN_OUTPUT_CHARS,
      },
      'Paired turn output truncated — agent output exceeds storage limit',
    );
  }
  db.prepare(
    `INSERT OR REPLACE INTO paired_turn_outputs
       (task_id, turn_number, role, output_text, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    turnNumber,
    role,
    outputText.slice(0, MAX_TURN_OUTPUT_CHARS),
    new Date().toISOString(),
  );
}

export function getPairedTurnOutputs(taskId: string): PairedTurnOutput[] {
  return db
    .prepare(
      `SELECT * FROM paired_turn_outputs
        WHERE task_id = ?
        ORDER BY turn_number ASC`,
    )
    .all(taskId) as PairedTurnOutput[];
}

export function getLatestTurnNumber(taskId: string): number {
  const row = db
    .prepare(
      `SELECT MAX(turn_number) as max_turn
        FROM paired_turn_outputs
        WHERE task_id = ?`,
    )
    .get(taskId) as { max_turn: number | null } | undefined;
  return row?.max_turn ?? 0;
}
