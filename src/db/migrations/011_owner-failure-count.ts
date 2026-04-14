import type { Database } from 'bun:sqlite';

import { tableHasColumn } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

export const OWNER_FAILURE_COUNT_MIGRATION: SchemaMigrationDefinition = {
  version: 11,
  name: 'owner_failure_count',
  apply(database: Database) {
    if (!tableHasColumn(database, 'paired_tasks', 'owner_failure_count')) {
      database.exec(`
        ALTER TABLE paired_tasks
        ADD COLUMN owner_failure_count INTEGER NOT NULL DEFAULT 0
      `);
    }

    database.exec(`
      UPDATE paired_tasks
         SET owner_failure_count = 0
       WHERE owner_failure_count IS NULL
    `);
  },
};
