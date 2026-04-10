import type { SchemaMigrationDefinition } from './types.js';
import { tryExecMigration } from './helpers.js';

export const SCHEDULED_TASK_COLUMNS_MIGRATION = {
  version: 2,
  name: 'scheduled_task_columns',
  apply(database) {
    tryExecMigration(
      database,
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE scheduled_tasks ADD COLUMN agent_type TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE scheduled_tasks ADD COLUMN ci_provider TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE scheduled_tasks ADD COLUMN ci_metadata TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE scheduled_tasks ADD COLUMN max_duration_ms INTEGER`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE scheduled_tasks ADD COLUMN status_message_id TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE scheduled_tasks ADD COLUMN status_started_at TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE scheduled_tasks ADD COLUMN suspended_until TEXT`,
    );
  },
} satisfies SchemaMigrationDefinition;
