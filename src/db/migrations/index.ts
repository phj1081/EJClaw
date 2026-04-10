import type { Database } from 'bun:sqlite';

import { LEGACY_SCHEMA_BUNDLE_MIGRATION } from './001_legacy-schema-bundle.js';
import type {
  SchemaMigrationArgs,
  SchemaMigrationDefinition,
} from './types.js';

const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';

const ORDERED_SCHEMA_MIGRATIONS: readonly SchemaMigrationDefinition[] = [
  LEGACY_SCHEMA_BUNDLE_MIGRATION,
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

    migration.apply(database, args);
    if (!alreadyApplied) {
      recordAppliedSchemaMigration(database, migration);
    }
  }
}
