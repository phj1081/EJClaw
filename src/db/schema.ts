import { Database } from 'bun:sqlite';

import { tryExecMigration } from './migrations/helpers.js';

// Legacy monolithic migration entrypoint kept only for databases that predate
// ordered schema migration tracking. New schema changes belong in
// src/db/migrations/*.

export function applyLegacySchemaMigrations(
  database: Database,
  _args: {
    assistantName: string;
  },
): void {
  // Some legacy columns must exist before later numbered migrations can run.
  // `work_items.service_id` / `delivery_role` are referenced by v4 indexes.
  tryExecMigration(
    database,
    `ALTER TABLE work_items ADD COLUMN delivery_role TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE work_items ADD COLUMN service_id TEXT`,
  );
}

/** @deprecated New schema changes should be added under src/db/migrations/*. */
export const applySchemaMigrations = applyLegacySchemaMigrations;
