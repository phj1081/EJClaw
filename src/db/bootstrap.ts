import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import { readJsonFile } from '../utils.js';
import { applyBaseSchema } from './base-schema.js';
import { type SchemaMigrationHooks, applySchemaMigrations } from './schema.js';

export interface JsonStateMigrationHooks {
  setRouterState(key: string, value: string): void;
  setSession(groupFolder: string, sessionId: string): void;
  writeLegacyRegisteredGroupAndSyncRoomSettings(
    jid: string,
    group: RegisteredGroup,
  ): void;
}

export function initializeDatabaseSchema(
  database: Database,
  hooks: SchemaMigrationHooks,
): void {
  applyBaseSchema(database);
  applySchemaMigrations(database, {
    assistantName: ASSISTANT_NAME,
    hooks,
  });
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

export function migrateJsonStateFromFiles(
  hooks: JsonStateMigrationHooks,
): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    const data = readJsonFile(filePath);
    if (data === null) return null;
    try {
      fs.renameSync(filePath, `${filePath}.migrated`);
    } catch {
      /* best effort */
    }
    return data;
  };

  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      hooks.setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      hooks.setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      hooks.setSession(folder, sessionId);
    }
  }

  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        hooks.writeLegacyRegisteredGroupAndSyncRoomSettings(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
