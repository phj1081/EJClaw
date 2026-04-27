import type { Database } from 'bun:sqlite';

import { tableHasColumn } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

export const TURN_PROGRESS_TEXT_MIGRATION: SchemaMigrationDefinition = {
  version: 15,
  name: 'turn_progress_text',
  apply(database: Database) {
    if (!tableHasColumn(database, 'paired_turns', 'progress_text')) {
      database.exec(`ALTER TABLE paired_turns ADD COLUMN progress_text TEXT`);
    }
    if (!tableHasColumn(database, 'paired_turns', 'progress_updated_at')) {
      database.exec(
        `ALTER TABLE paired_turns ADD COLUMN progress_updated_at TEXT`,
      );
    }
  },
};
