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

function getExpectedSchemaMigrations(): Array<{
  version: number;
  name: string;
}> {
  return [
    { version: 1, name: 'legacy_schema_bundle' },
    { version: 2, name: 'scheduled_task_columns' },
    { version: 3, name: 'room_registration_canonical_columns' },
    { version: 4, name: 'message_seq_and_work_item_indexes' },
    { version: 5, name: 'sessions_composite_key' },
    { version: 6, name: 'chat_channel_metadata' },
    { version: 7, name: 'runtime_service_metadata' },
    { version: 8, name: 'paired_task_schema_cleanup' },
    { version: 9, name: 'paired_workspace_project_schema_cleanup' },
    { version: 10, name: 'paired_turn_provenance_upgrade' },
    { version: 11, name: 'owner_failure_count' },
    { version: 12, name: 'paired_verdict_and_step_telemetry' },
    { version: 13, name: 'message_source_kind' },
    { version: 14, name: 'work_item_attachments' },
    { version: 15, name: 'turn_progress_text' },
    { version: 16, name: 'room_skill_overrides' },
  ];
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

      expect(getAppliedSchemaMigrations(database)).toEqual(
        getExpectedSchemaMigrations(),
      );
    } finally {
      database.close();
    }
  });

  it('does not duplicate schema migration rows on repeated initialization', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);
      initializeDatabaseSchema(database);

      expect(getAppliedSchemaMigrations(database)).toEqual(
        getExpectedSchemaMigrations(),
      );
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

      expect(getAppliedSchemaMigrations(reopened)).toEqual(
        getExpectedSchemaMigrations(),
      );
    } finally {
      reopened.close();
    }
  });
});
