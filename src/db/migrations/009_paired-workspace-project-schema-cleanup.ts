import type { SchemaMigrationDefinition } from './types.js';

export const PAIRED_WORKSPACE_PROJECT_SCHEMA_CLEANUP_MIGRATION = {
  version: 9,
  name: 'paired_workspace_project_schema_cleanup',
  apply(database) {
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
  },
} satisfies SchemaMigrationDefinition;
