import type { SchemaMigrationDefinition } from './types.js';
import { tryExecMigration } from './helpers.js';

export const SCHEDULED_TASK_ROOM_ROLE_MIGRATION = {
  version: 17,
  name: 'scheduled_task_room_role',
  apply(database) {
    tryExecMigration(
      database,
      `ALTER TABLE scheduled_tasks ADD COLUMN room_role TEXT`,
    );
  },
} satisfies SchemaMigrationDefinition;
