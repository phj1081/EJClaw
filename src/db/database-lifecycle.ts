import { Database } from 'bun:sqlite';

import { DATA_DIR, normalizeServiceId, SERVICE_ID } from '../config.js';
import { listUnexpectedDataStateFiles } from '../data-state-files.js';
import {
  openDatabaseFromFile,
  openInMemoryDatabase,
  openPersistentDatabase,
  initializeDatabaseSchema,
} from './bootstrap.js';
import { countPendingLegacyRegisteredGroupRows } from './room-registration.js';
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

function assertNoPendingLegacyRoomMigration(database: Database): void {
  const pendingLegacyRows = countPendingLegacyRegisteredGroupRows(database);
  if (pendingLegacyRows === 0) {
    return;
  }

  throw new Error(
    `Legacy room migration required before startup (pending_rows=${pendingLegacyRows})`,
  );
}

function assertNoUnexpectedDataStateFiles(): void {
  const pendingFiles = listUnexpectedDataStateFiles(DATA_DIR);
  if (pendingFiles.length === 0) {
    return;
  }

  throw new Error(
    `Unexpected data state files detected before startup (files=${pendingFiles.join(',')})`,
  );
}

function assertNoUnsupportedRouterStateDbKeys(database: Database): void {
  const unsupportedKeys = getUnsupportedRouterStateKeysFromDatabase(database);
  if (unsupportedKeys.length === 0) {
    return;
  }

  throw new Error(
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
