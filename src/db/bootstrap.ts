import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { applyBaseSchema } from './base-schema.js';
import { applyVersionedSchemaMigrations } from './migrations/index.js';

function isFreshDatabase(database: Database): boolean {
  const row = database
    .prepare(
      `
        SELECT COUNT(*) AS count
          FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name != 'schema_migrations'
      `,
    )
    .get() as { count: number };
  return row.count === 0;
}

function setForeignKeys(database: Database, enabled: boolean): void {
  database.exec(`PRAGMA foreign_keys = ${enabled ? 'ON' : 'OFF'}`);
}

function assertNoForeignKeyViolations(database: Database): void {
  const violations = database
    .prepare('PRAGMA foreign_key_check')
    .all() as Array<{
    table: string;
    rowid: number;
    parent: string;
    fkid: number;
  }>;
  if (violations.length === 0) {
    return;
  }

  const violation = violations[0]!;
  throw new Error(
    `Foreign key integrity check failed for ${violation.table}(rowid=${violation.rowid}) referencing ${violation.parent} [fk=${violation.fkid}]`,
  );
}

export function initializeDatabaseSchema(database: Database): void {
  setForeignKeys(database, false);
  if (isFreshDatabase(database)) {
    applyBaseSchema(database);
  }
  applyVersionedSchemaMigrations(database, {
    assistantName: ASSISTANT_NAME,
  });
  setForeignKeys(database, true);
  assertNoForeignKeyViolations(database);
}

export function openPersistentDatabase(): Database {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const database = new Database(dbPath);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');
  return database;
}

export function openInMemoryDatabase(): Database {
  return new Database(':memory:');
}

export function openDatabaseFromFile(dbPath: string): Database {
  return new Database(dbPath);
}
