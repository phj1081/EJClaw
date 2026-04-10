import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { applyBaseSchema } from './base-schema.js';
import { initializeDatabaseSchema } from './bootstrap.js';
import { applyLegacySchemaMigrations } from './schema.js';

function getAppliedSchemaMigrations(
  database: Database,
): Array<{ version: number; name: string }> {
  return database
    .prepare(
      `SELECT version, name
         FROM schema_migrations
        ORDER BY version ASC`,
    )
    .all() as Array<{ version: number; name: string }>;
}

describe('initializeDatabaseSchema', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records the legacy schema bundle as version 1 on a fresh database', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);

      expect(getAppliedSchemaMigrations(database)).toEqual([
        {
          version: 1,
          name: 'legacy_schema_bundle',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('does not duplicate schema migration rows on repeated initialization', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);
      initializeDatabaseSchema(database);

      expect(getAppliedSchemaMigrations(database)).toEqual([
        {
          version: 1,
          name: 'legacy_schema_bundle',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('backfills schema migration tracking for an existing pre-versioned database', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-schema-migrations-'),
    );
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    try {
      applyBaseSchema(legacyDb);
      applyLegacySchemaMigrations(legacyDb, {
        assistantName: 'Andy',
      });
    } finally {
      legacyDb.close();
    }

    const reopened = new Database(dbPath);

    try {
      initializeDatabaseSchema(reopened);

      expect(getAppliedSchemaMigrations(reopened)).toEqual([
        {
          version: 1,
          name: 'legacy_schema_bundle',
        },
      ]);
    } finally {
      reopened.close();
    }
  });
});
