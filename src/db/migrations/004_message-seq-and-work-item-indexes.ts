import type { SchemaMigrationDefinition } from './types.js';
import { backfillMessageSeq, tryExecMigration } from './helpers.js';

export const MESSAGE_SEQ_AND_WORK_ITEM_INDEXES_MIGRATION = {
  version: 4,
  name: 'message_seq_and_work_item_indexes',
  apply(database, args) {
    try {
      database.exec(
        `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
      );
      database
        .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
        .run(`${args.assistantName}:%`);
    } catch {
      /* column already exists */
    }

    tryExecMigration(database, `ALTER TABLE messages ADD COLUMN seq INTEGER`);
    backfillMessageSeq(database);

    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_jid_seq ON messages(chat_jid, seq);
    `);
    database.exec(`DROP INDEX IF EXISTS idx_work_items_group_agent;`);
    database.exec(`DROP INDEX IF EXISTS idx_work_items_open;`);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_work_items_group_agent
        ON work_items(chat_jid, agent_type, service_id, delivery_role, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_open
        ON work_items(chat_jid, agent_type, IFNULL(service_id, ''), IFNULL(delivery_role, ''))
        WHERE status IN ('produced', 'delivery_retry');
    `);
  },
} satisfies SchemaMigrationDefinition;
