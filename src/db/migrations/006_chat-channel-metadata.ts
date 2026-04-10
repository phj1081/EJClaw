import type { SchemaMigrationDefinition } from './types.js';

export const CHAT_CHANNEL_METADATA_MIGRATION = {
  version: 6,
  name: 'chat_channel_metadata',
  apply(database) {
    try {
      database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
      database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
      database.exec(
        `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
      );
      database.exec(
        `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
      );
      database.exec(
        `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
      );
      database.exec(
        `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
      );
    } catch {
      /* columns already exist */
    }
  },
} satisfies SchemaMigrationDefinition;
