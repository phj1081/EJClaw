import type { SchemaMigrationDefinition } from './types.js';
import { getTableColumns, tryExecMigration } from './helpers.js';

export const PAIRED_TASK_SCHEMA_CLEANUP_MIGRATION = {
  version: 8,
  name: 'paired_task_schema_cleanup',
  apply(database) {
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

    const ptSqlRow = database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paired_tasks'`,
      )
      .get() as { sql?: string } | undefined;
    const ptSql = ptSqlRow?.sql || '';
    if (ptSql && !ptSql.includes('arbiter_requested')) {
      const pairedTaskCols = getTableColumns(database, 'paired_tasks');
      const selectPairedTaskColumn = (columnName: string): string =>
        pairedTaskCols.includes(columnName)
          ? columnName
          : `NULL AS ${columnName}`;
      database.exec(`
        CREATE TABLE paired_tasks_new (
          id TEXT PRIMARY KEY,
          chat_jid TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          owner_service_id TEXT,
          reviewer_service_id TEXT,
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
          id, chat_jid, group_folder, owner_service_id, reviewer_service_id,
          owner_agent_type, reviewer_agent_type,
          arbiter_agent_type, title, source_ref, plan_notes, review_requested_at,
          round_trip_count, status, created_at, updated_at
        )
        SELECT
          id, chat_jid, group_folder,
          ${selectPairedTaskColumn('owner_service_id')},
          ${selectPairedTaskColumn('reviewer_service_id')},
          owner_agent_type, reviewer_agent_type,
          arbiter_agent_type, title, source_ref, plan_notes, review_requested_at,
          round_trip_count, status, created_at, updated_at
        FROM paired_tasks;
        DROP TABLE paired_tasks;
        ALTER TABLE paired_tasks_new RENAME TO paired_tasks;
        CREATE INDEX IF NOT EXISTS idx_paired_tasks_chat_status
          ON paired_tasks(chat_jid, status, updated_at);
      `);
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
  },
} satisfies SchemaMigrationDefinition;
