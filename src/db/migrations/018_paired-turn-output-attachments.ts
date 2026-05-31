import type { Database } from 'bun:sqlite';

import { tableHasColumn } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

export const PAIRED_TURN_OUTPUT_ATTACHMENTS_MIGRATION: SchemaMigrationDefinition =
  {
    version: 18,
    name: 'paired_turn_output_attachments',
    apply(database: Database) {
      if (
        !tableHasColumn(database, 'paired_turn_outputs', 'attachment_payload')
      ) {
        database.exec(`
          ALTER TABLE paired_turn_outputs
          ADD COLUMN attachment_payload TEXT
        `);
      }
    },
  };
