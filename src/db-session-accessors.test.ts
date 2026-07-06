import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _initTestDatabaseFromFile,
  deleteSession,
  getSession,
  setSession,
} from './db.js';
import { CLAUDE_SERVICE_ID } from './config.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('session accessors', () => {
  it('deletes only the current service session for a group', () => {
    setSession('group-a', 'session-123');
    expect(getSession('group-a')).toBe('session-123');

    deleteSession('group-a');
    expect(getSession('group-a')).toBeUndefined();
  });

  it('migrates legacy sessions table rows into the composite primary key schema', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-session-schema-migration-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE sessions (
        group_folder TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO sessions (group_folder, session_id)
         VALUES (?, ?)`,
      )
      .run('group-legacy-schema', 'legacy-schema-session-123');
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getSession('group-legacy-schema', 'claude-code')).toBe(
      'legacy-schema-session-123',
    );

    const migratedDb = new Database(dbPath, { readonly: true });
    const sessionColumns = migratedDb
      .prepare(`PRAGMA table_info(sessions)`)
      .all() as Array<{ name: string }>;
    expect(sessionColumns.some((col) => col.name === 'agent_type')).toBe(true);
    migratedDb.close();
  });

  it('backfills legacy service_sessions rows into sessions during init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-service-sessions-backfill-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE sessions (
        group_folder TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
      );
      CREATE TABLE service_sessions (
        group_folder TEXT NOT NULL,
        service_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY (group_folder, service_id)
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO service_sessions (group_folder, service_id, session_id)
         VALUES (?, ?, ?)`,
      )
      .run('group-legacy', CLAUDE_SERVICE_ID, 'legacy-service-session-123');
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getSession('group-legacy', 'claude-code')).toBe(
      'legacy-service-session-123',
    );

    const migratedDb = new Database(dbPath, { readonly: true });
    const hasServiceSessions = Boolean(
      migratedDb
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'service_sessions'`,
        )
        .get(),
    );
    expect(hasServiceSessions).toBe(false);
    migratedDb.close();
  });
});
