import type { SchemaMigrationDefinition } from './types.js';
import { tableHasColumn, tryExecMigration } from './helpers.js';

export const ROOM_REGISTRATION_CANONICAL_COLUMNS_MIGRATION = {
  version: 3,
  name: 'room_registration_canonical_columns',
  apply(database) {
    tryExecMigration(
      database,
      `ALTER TABLE room_settings ADD COLUMN mode_source TEXT NOT NULL DEFAULT 'explicit'`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE room_settings ADD COLUMN name TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE room_settings ADD COLUMN folder TEXT`,
    );
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
      `ALTER TABLE room_settings ADD COLUMN created_at TEXT`,
    );

    if (tableHasColumn(database, 'room_settings', 'created_at')) {
      database.exec(`
        UPDATE room_settings
           SET created_at = COALESCE(created_at, updated_at, CURRENT_TIMESTAMP)
      `);
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS room_role_overrides (
        chat_jid TEXT NOT NULL,
        role TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        agent_config_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_jid, role),
        CHECK (role IN ('owner', 'reviewer', 'arbiter')),
        CHECK (agent_type IN ('claude-code', 'codex'))
      )
    `);

    database.exec(
      `UPDATE room_settings
       SET mode_source = 'explicit'
       WHERE COALESCE(mode_source, '') NOT IN ('explicit', 'inferred')`,
    );
  },
} satisfies SchemaMigrationDefinition;
