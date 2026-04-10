import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { applyBaseSchema } from './base-schema.js';
import { applySchemaMigrations } from './schema.js';

function setForeignKeys(database: Database, enabled: boolean): void {
  database.exec(`PRAGMA foreign_keys = ${enabled ? 'ON' : 'OFF'}`);
}

function pruneOrphanTaskRunLogs(database: Database): number {
  const result = database
    .prepare(
      `DELETE FROM task_run_logs
       WHERE NOT EXISTS (
         SELECT 1 FROM scheduled_tasks
         WHERE scheduled_tasks.id = task_run_logs.task_id
       )`,
    )
    .run();
  return result.changes;
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
  applyBaseSchema(database);
  applySchemaMigrations(database, {
    assistantName: ASSISTANT_NAME,
  });
  const prunedTaskRunLogs = pruneOrphanTaskRunLogs(database);
  setForeignKeys(database, true);
  assertNoForeignKeyViolations(database);
  if (prunedTaskRunLogs > 0) {
    logger.warn(
      { count: prunedTaskRunLogs },
      'Pruned orphan task_run_logs rows during database initialization',
    );
  }
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
