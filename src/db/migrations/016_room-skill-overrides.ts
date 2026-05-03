import type { Database } from 'bun:sqlite';

import type { SchemaMigrationDefinition } from './types.js';

export const ROOM_SKILL_OVERRIDES_MIGRATION: SchemaMigrationDefinition = {
  version: 16,
  name: 'room_skill_overrides',
  apply(database: Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS room_skill_overrides (
        chat_jid TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        skill_scope TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_jid, agent_type, skill_scope, skill_name),
        FOREIGN KEY (chat_jid) REFERENCES room_settings(chat_jid) ON DELETE CASCADE,
        CHECK (agent_type IN ('claude-code', 'codex')),
        CHECK (enabled IN (0, 1)),
        CHECK (length(skill_scope) > 0),
        CHECK (length(skill_name) > 0)
      );
      CREATE INDEX IF NOT EXISTS idx_room_skill_overrides_room
        ON room_skill_overrides(chat_jid, agent_type);
    `);
  },
};
