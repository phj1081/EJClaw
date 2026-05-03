import type { Database } from 'bun:sqlite';

import { LEGACY_SCHEMA_BUNDLE_MIGRATION } from './001_legacy-schema-bundle.js';
import { SCHEDULED_TASK_COLUMNS_MIGRATION } from './002_scheduled-task-columns.js';
import { ROOM_REGISTRATION_CANONICAL_COLUMNS_MIGRATION } from './003_room-registration-canonical-columns.js';
import { MESSAGE_SEQ_AND_WORK_ITEM_INDEXES_MIGRATION } from './004_message-seq-and-work-item-indexes.js';
import { SESSIONS_COMPOSITE_KEY_MIGRATION } from './005_sessions-composite-key.js';
import { CHAT_CHANNEL_METADATA_MIGRATION } from './006_chat-channel-metadata.js';
import { RUNTIME_SERVICE_METADATA_MIGRATION } from './007_runtime-service-metadata.js';
import { PAIRED_TASK_SCHEMA_CLEANUP_MIGRATION } from './008_paired-task-schema-cleanup.js';
import { PAIRED_WORKSPACE_PROJECT_SCHEMA_CLEANUP_MIGRATION } from './009_paired-workspace-project-schema-cleanup.js';
import { PAIRED_TURN_PROVENANCE_UPGRADE_MIGRATION } from './010_paired-turn-provenance-upgrade.js';
import { OWNER_FAILURE_COUNT_MIGRATION } from './011_owner-failure-count.js';
import { PAIRED_VERDICT_AND_STEP_TELEMETRY_MIGRATION } from './012_paired-verdict-and-step-telemetry.js';
import { MESSAGE_SOURCE_KIND_MIGRATION } from './013_message-source-kind.js';
import { WORK_ITEM_ATTACHMENTS_MIGRATION } from './014_work-item-attachments.js';
import { TURN_PROGRESS_TEXT_MIGRATION } from './015_turn-progress-text.js';
import { ROOM_SKILL_OVERRIDES_MIGRATION } from './016_room-skill-overrides.js';
import type {
  SchemaMigrationArgs,
  SchemaMigrationDefinition,
} from './types.js';

const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';

const ORDERED_SCHEMA_MIGRATIONS: readonly SchemaMigrationDefinition[] = [
  LEGACY_SCHEMA_BUNDLE_MIGRATION,
  SCHEDULED_TASK_COLUMNS_MIGRATION,
  ROOM_REGISTRATION_CANONICAL_COLUMNS_MIGRATION,
  MESSAGE_SEQ_AND_WORK_ITEM_INDEXES_MIGRATION,
  SESSIONS_COMPOSITE_KEY_MIGRATION,
  CHAT_CHANNEL_METADATA_MIGRATION,
  RUNTIME_SERVICE_METADATA_MIGRATION,
  PAIRED_TASK_SCHEMA_CLEANUP_MIGRATION,
  PAIRED_WORKSPACE_PROJECT_SCHEMA_CLEANUP_MIGRATION,
  PAIRED_TURN_PROVENANCE_UPGRADE_MIGRATION,
  OWNER_FAILURE_COUNT_MIGRATION,
  PAIRED_VERDICT_AND_STEP_TELEMETRY_MIGRATION,
  MESSAGE_SOURCE_KIND_MIGRATION,
  WORK_ITEM_ATTACHMENTS_MIGRATION,
  TURN_PROGRESS_TEXT_MIGRATION,
  ROOM_SKILL_OVERRIDES_MIGRATION,
];

function ensureSchemaMigrationsTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function getAppliedSchemaVersions(database: Database): Set<number> {
  const rows = database
    .prepare(
      `SELECT version
         FROM ${SCHEMA_MIGRATIONS_TABLE}
        ORDER BY version ASC`,
    )
    .all() as Array<{ version: number }>;
  return new Set(rows.map((row) => row.version));
}

function recordAppliedSchemaMigration(
  database: Database,
  migration: SchemaMigrationDefinition,
): void {
  database
    .prepare(
      `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, name)
       VALUES (?, ?)`,
    )
    .run(migration.version, migration.name);
}

export function applyVersionedSchemaMigrations(
  database: Database,
  args: SchemaMigrationArgs,
): void {
  ensureSchemaMigrationsTable(database);
  const appliedVersions = getAppliedSchemaVersions(database);

  for (const migration of ORDERED_SCHEMA_MIGRATIONS) {
    const alreadyApplied = appliedVersions.has(migration.version);
    if (alreadyApplied && !migration.alwaysRun) {
      continue;
    }

    // Fail fast: a partially-applied migration must not be recorded as complete.
    migration.apply(database, args);
    if (!alreadyApplied) {
      recordAppliedSchemaMigration(database, migration);
    }
  }
}
