import { Database } from 'bun:sqlite';

import { inferAgentTypeFromServiceShadow } from '../role-service-shadow.js';
import {
  backfillLegacyServiceSessions,
  dropLegacyServiceSessionsTable,
  migrateSessionsTableToCompositePk,
} from './sessions.js';

export interface SchemaMigrationHooks {
  backfillMessageSeq(database: Database): void;
  backfillStoredRoomSettings(database: Database): void;
  backfillChannelOwnerRoleMetadata(database: Database): void;
  backfillWorkItemServiceShadows(database: Database): void;
  backfillServiceHandoffServiceShadows(database: Database): void;
  backfillPairedTaskRoleMetadata(database: Database): void;
  rebuildWorkItemsCanonicalSchema(database: Database): void;
  rebuildChannelOwnerCanonicalSchema(database: Database): void;
  rebuildPairedTasksCanonicalSchema(database: Database): void;
  rebuildServiceHandoffsCanonicalSchema(database: Database): void;
}

function getTableColumns(database: Database, tableName: string): string[] {
  return (
    database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

export function tableHasColumn(
  database: Database,
  tableName: string,
  columnName: string,
): boolean {
  return getTableColumns(database, tableName).includes(columnName);
}

function tryExecMigration(database: Database, sql: string): void {
  try {
    database.exec(sql);
  } catch {
    /* column already exists */
  }
}

export function applySchemaMigrations(
  database: Database,
  args: {
    assistantName: string;
    hooks: SchemaMigrationHooks;
  },
): void {
  const { assistantName, hooks } = args;

  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN agent_type TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN ci_provider TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN ci_metadata TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN max_duration_ms INTEGER`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN status_message_id TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN status_started_at TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN suspended_until TEXT`,
  );

  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN mode_source TEXT NOT NULL DEFAULT 'explicit'`,
  );
  tryExecMigration(database, `ALTER TABLE room_settings ADD COLUMN name TEXT`);
  tryExecMigration(database, `ALTER TABLE room_settings ADD COLUMN folder TEXT`);
  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN trigger_pattern TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN requires_trigger INTEGER DEFAULT 1`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN is_main INTEGER DEFAULT 0`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN owner_agent_type TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN work_dir TEXT`,
  );

  tryExecMigration(
    database,
    `ALTER TABLE service_handoffs ADD COLUMN intended_role TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE service_handoffs ADD COLUMN source_role TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE service_handoffs ADD COLUMN target_role TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE service_handoffs ADD COLUMN source_agent_type TEXT`,
  );

  tryExecMigration(
    database,
    `ALTER TABLE paired_tasks ADD COLUMN owner_agent_type TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE paired_tasks ADD COLUMN reviewer_agent_type TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE paired_tasks ADD COLUMN arbiter_agent_type TEXT`,
  );

  tryExecMigration(
    database,
    `ALTER TABLE work_items ADD COLUMN delivery_role TEXT`,
  );

  database.exec(
    `UPDATE service_handoffs
     SET target_role = COALESCE(
       target_role,
       intended_role,
       CASE
         WHEN reason LIKE 'reviewer-%' THEN 'reviewer'
         WHEN reason LIKE 'arbiter-%' THEN 'arbiter'
         WHEN reason IS NOT NULL THEN 'owner'
         ELSE NULL
       END
     )
     WHERE target_role IS NULL`,
  );

  database.exec(
    `UPDATE service_handoffs
     SET source_role = COALESCE(source_role, target_role, intended_role)
     WHERE source_role IS NULL`,
  );

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

  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${assistantName}:%`);
  } catch {
    /* column already exists */
  }

  tryExecMigration(database, `ALTER TABLE messages ADD COLUMN seq INTEGER`);

  hooks.backfillMessageSeq(database);

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_jid_seq ON messages(chat_jid, seq);
  `);
  database.exec(`DROP INDEX IF EXISTS idx_work_items_group_agent;`);
  database.exec(`DROP INDEX IF EXISTS idx_work_items_open;`);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_group_agent
      ON work_items(chat_jid, agent_type, delivery_role, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_open
      ON work_items(chat_jid, agent_type, IFNULL(delivery_role, ''))
      WHERE status IN ('produced', 'delivery_retry');
  `);

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
        owner_agent_type TEXT,
        reviewer_agent_type TEXT,
        arbiter_agent_type TEXT,
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
        CHECK (status IN ('active', 'review_ready', 'in_review', 'merge_ready', 'completed', 'arbiter_requested', 'in_arbitration')),
        CHECK (owner_agent_type IN ('claude-code', 'codex') OR owner_agent_type IS NULL),
        CHECK (reviewer_agent_type IN ('claude-code', 'codex') OR reviewer_agent_type IS NULL),
        CHECK (arbiter_agent_type IN ('claude-code', 'codex') OR arbiter_agent_type IS NULL)
      );
      CREATE INDEX IF NOT EXISTS idx_paired_tasks_chat_status
        ON paired_tasks(chat_jid, status, updated_at);
    `);
  }

  {
    const ptSqlRow = database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paired_tasks'`,
      )
      .get() as { sql?: string } | undefined;
    const ptSql = ptSqlRow?.sql || '';
    if (ptSql && !ptSql.includes('arbiter_requested')) {
      database.exec(`
        CREATE TABLE paired_tasks_new (
          id TEXT PRIMARY KEY,
          chat_jid TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          owner_agent_type TEXT,
          reviewer_agent_type TEXT,
          arbiter_agent_type TEXT,
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
          CHECK (status IN ('active', 'review_ready', 'in_review', 'merge_ready', 'completed', 'arbiter_requested', 'in_arbitration')),
          CHECK (owner_agent_type IN ('claude-code', 'codex') OR owner_agent_type IS NULL),
          CHECK (reviewer_agent_type IN ('claude-code', 'codex') OR reviewer_agent_type IS NULL),
          CHECK (arbiter_agent_type IN ('claude-code', 'codex') OR arbiter_agent_type IS NULL)
        );
        INSERT INTO paired_tasks_new (
          id, chat_jid, group_folder, owner_agent_type, reviewer_agent_type,
          arbiter_agent_type, title, source_ref, plan_notes, review_requested_at,
          round_trip_count, status, created_at, updated_at
        )
        SELECT
          id, chat_jid, group_folder, owner_agent_type, reviewer_agent_type,
          arbiter_agent_type, title, source_ref, plan_notes, review_requested_at,
          round_trip_count, status, created_at, updated_at
        FROM paired_tasks;
        DROP TABLE paired_tasks;
        ALTER TABLE paired_tasks_new RENAME TO paired_tasks;
        CREATE INDEX IF NOT EXISTS idx_paired_tasks_chat_status
          ON paired_tasks(chat_jid, status, updated_at);
      `);
    }
  }

  for (const column of [
    'owner_agent_type',
    'reviewer_agent_type',
    'arbiter_agent_type',
  ]) {
    tryExecMigration(
      database,
      `ALTER TABLE channel_owner ADD COLUMN ${column} TEXT`,
    );
  }

  tryExecMigration(
    database,
    `ALTER TABLE paired_tasks ADD COLUMN completion_reason TEXT`,
  );

  for (const table of [
    'paired_executions',
    'paired_approvals',
    'paired_artifacts',
    'paired_events',
  ]) {
    database.exec(`DROP TABLE IF EXISTS ${table}`);
  }

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

  migrateSessionsTableToCompositePk(database, 'claude-code');

  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
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

  hooks.backfillStoredRoomSettings(database);
  if (tableHasColumn(database, 'channel_owner', 'owner_service_id')) {
    hooks.backfillChannelOwnerRoleMetadata(database);
  }
  backfillLegacyServiceSessions(database, inferAgentTypeFromServiceShadow);
  if (tableHasColumn(database, 'work_items', 'service_id')) {
    hooks.backfillWorkItemServiceShadows(database);
  }
  if (tableHasColumn(database, 'service_handoffs', 'source_service_id')) {
    hooks.backfillServiceHandoffServiceShadows(database);
  }
  if (tableHasColumn(database, 'paired_tasks', 'owner_service_id')) {
    hooks.backfillPairedTaskRoleMetadata(database);
  }

  hooks.rebuildWorkItemsCanonicalSchema(database);
  dropLegacyServiceSessionsTable(database);
  hooks.rebuildChannelOwnerCanonicalSchema(database);
  hooks.rebuildPairedTasksCanonicalSchema(database);
  hooks.rebuildServiceHandoffsCanonicalSchema(database);
}
