import type { Database } from 'bun:sqlite';

import { tableHasColumn } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

export const MESSAGE_SOURCE_KIND_MIGRATION: SchemaMigrationDefinition = {
  version: 13,
  name: 'message_source_kind',
  apply(database: Database) {
    const addedColumn = !tableHasColumn(
      database,
      'messages',
      'message_source_kind',
    );
    if (addedColumn) {
      database.exec(`
        ALTER TABLE messages
        ADD COLUMN message_source_kind TEXT NOT NULL DEFAULT 'human'
      `);
    }

    const invalidOnlyWhere = `
       WHERE message_source_kind IS NULL
          OR message_source_kind = ''
          OR message_source_kind NOT IN (
            'human',
            'bot',
            'trusted_external_bot',
            'ipc_injected_human',
            'ipc_injected_bot'
          )
    `;

    database.exec(`
      UPDATE messages
         SET message_source_kind = CASE
           WHEN is_bot_message = 1 THEN 'bot'
           ELSE 'human'
         END
      ${addedColumn ? '' : invalidOnlyWhere}
    `);
  },
};
