import { Database } from 'bun:sqlite';

import { DATA_DIR, normalizeServiceId, SERVICE_ID } from '../config.js';
import { listUnexpectedDataStateFiles } from '../data-state-files.js';
import { StartupPreconditionError } from '../startup-preconditions.js';
import {
  openDatabaseFromFile,
  openInMemoryDatabase,
  openPersistentDatabase,
  initializeDatabaseSchema,
} from './bootstrap.js';
import {
  clearExpiredPairedTaskExecutionLeasesInDatabase,
  clearPairedTaskExecutionLeasesForServiceInDatabase,
} from './paired-state.js';
import { getUnsupportedRouterStateKeysFromDatabase } from './router-state.js';

function finalizeDatabaseInitialization(database: Database): void {
  clearPairedTaskExecutionLeasesForServiceInDatabase(
    database,
    normalizeServiceId(SERVICE_ID),
  );
  clearExpiredPairedTaskExecutionLeasesInDatabase(database);
}

function getUnexpectedLegacyRoomBindingTables(database: Database): string[] {
  const tableRows = database
    .prepare(
      `SELECT name
         FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  const matches: string[] = [];

  for (const row of tableRows) {
    const columns = database
      .prepare(`PRAGMA table_info("${row.name.replaceAll('"', '""')}")`)
      .all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const looksLikeLegacyRoomBindingTable =
      columnNames.has('jid') &&
      columnNames.has('name') &&
      columnNames.has('folder') &&
      columnNames.has('trigger_pattern') &&
      columnNames.has('added_at');
    const isBackupTable = columnNames.has('backup_at');

    if (looksLikeLegacyRoomBindingTable && !isBackupTable) {
      matches.push(row.name);
    }
  }

  return matches;
}

function assertNoPendingLegacyRoomMigration(database: Database): void {
  const pendingTables = getUnexpectedLegacyRoomBindingTables(database);
  if (pendingTables.length === 0) {
    return;
  }

  throw new StartupPreconditionError(
    `Legacy room migration required before startup (tables=${pendingTables.join(',')})`,
  );
}

function assertNoUnexpectedDataStateFiles(): void {
  const pendingFiles = listUnexpectedDataStateFiles(DATA_DIR);
  if (pendingFiles.length === 0) {
    return;
  }

  throw new StartupPreconditionError(
    `Unexpected data state files detected before startup (files=${pendingFiles.join(',')})`,
  );
}

function assertNoUnsupportedRouterStateDbKeys(database: Database): void {
  const unsupportedKeys = getUnsupportedRouterStateKeysFromDatabase(database);
  if (unsupportedKeys.length === 0) {
    return;
  }

  throw new StartupPreconditionError(
    `Unsupported router_state DB keys remain before startup (keys=${unsupportedKeys.join(',')})`,
  );
}

export function openInitializedPersistentDatabase(): Database {
  const database = openPersistentDatabase();
  initializeDatabaseSchema(database);
  assertNoPendingLegacyRoomMigration(database);
  assertNoUnexpectedDataStateFiles();
  assertNoUnsupportedRouterStateDbKeys(database);
  finalizeDatabaseInitialization(database);
  return database;
}

export function openInitializedInMemoryDatabase(): Database {
  const database = openInMemoryDatabase();
  initializeDatabaseSchema(database);
  finalizeDatabaseInitialization(database);
  return database;
}

export function openInitializedDatabaseFromFile(dbPath: string): Database {
  const database = openDatabaseFromFile(dbPath);
  initializeDatabaseSchema(database);
  assertNoPendingLegacyRoomMigration(database);
  assertNoUnsupportedRouterStateDbKeys(database);
  finalizeDatabaseInitialization(database);
  return database;
}
