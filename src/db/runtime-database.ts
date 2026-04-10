import { Database } from 'bun:sqlite';

import {
  openInitializedDatabaseFromFile,
  openInitializedInMemoryDatabase,
  openInitializedPersistentDatabase,
} from './database-lifecycle.js';

let db: Database | undefined;

export function initDatabase(): void {
  db = openInitializedPersistentDatabase();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = openInitializedInMemoryDatabase();
}

/** @internal - for tests only. Opens an existing database file and runs schema/migrations. */
export function _initTestDatabaseFromFile(dbPath: string): void {
  db = openInitializedDatabaseFromFile(dbPath);
}

export function requireDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

export function getDatabaseIfInitialized(): Database | undefined {
  return db;
}
