import type { Database } from 'bun:sqlite';

import { tableHasColumn } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

export const WORK_ITEM_ATTACHMENTS_MIGRATION: SchemaMigrationDefinition = {
  version: 14,
  name: 'work_item_attachments',
  apply(database: Database) {
    if (!tableHasColumn(database, 'work_items', 'attachment_payload')) {
      database.exec(`
        ALTER TABLE work_items
        ADD COLUMN attachment_payload TEXT
      `);
    }
  },
};
