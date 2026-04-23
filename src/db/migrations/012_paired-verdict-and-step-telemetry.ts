import type { Database } from 'bun:sqlite';

import { tableHasColumn } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

export const PAIRED_VERDICT_AND_STEP_TELEMETRY_MIGRATION: SchemaMigrationDefinition =
  {
    version: 12,
    name: 'paired_verdict_and_step_telemetry',
    apply(database: Database) {
      if (!tableHasColumn(database, 'paired_turn_outputs', 'verdict')) {
        database.exec(`
        ALTER TABLE paired_turn_outputs
        ADD COLUMN verdict TEXT
      `);
      }

      if (!tableHasColumn(database, 'paired_tasks', 'owner_step_done_streak')) {
        database.exec(`
        ALTER TABLE paired_tasks
        ADD COLUMN owner_step_done_streak INTEGER NOT NULL DEFAULT 0
      `);
      }

      if (
        !tableHasColumn(database, 'paired_tasks', 'finalize_step_done_count')
      ) {
        database.exec(`
        ALTER TABLE paired_tasks
        ADD COLUMN finalize_step_done_count INTEGER NOT NULL DEFAULT 0
      `);
      }

      if (
        !tableHasColumn(
          database,
          'paired_tasks',
          'task_done_then_user_reopen_count',
        )
      ) {
        database.exec(`
        ALTER TABLE paired_tasks
        ADD COLUMN task_done_then_user_reopen_count INTEGER NOT NULL DEFAULT 0
      `);
      }

      if (!tableHasColumn(database, 'paired_tasks', 'empty_step_done_streak')) {
        database.exec(`
        ALTER TABLE paired_tasks
        ADD COLUMN empty_step_done_streak INTEGER NOT NULL DEFAULT 0
      `);
      }

      database.exec(`
      UPDATE paired_tasks
         SET owner_step_done_streak = 0
       WHERE owner_step_done_streak IS NULL
    `);
      database.exec(`
      UPDATE paired_tasks
         SET finalize_step_done_count = 0
       WHERE finalize_step_done_count IS NULL
    `);
      database.exec(`
      UPDATE paired_tasks
         SET task_done_then_user_reopen_count = 0
       WHERE task_done_then_user_reopen_count IS NULL
    `);
      database.exec(`
      UPDATE paired_tasks
         SET empty_step_done_streak = 0
       WHERE empty_step_done_streak IS NULL
    `);
    },
  };
