import { applyBaseSchema } from '../base-schema.js';
import { applyLegacySchemaMigrations } from '../schema.js';
import type { SchemaMigrationDefinition } from './types.js';

const LEGACY_BASELINE_TABLES = [
  'chats',
  'messages',
  'message_sequence',
  'work_items',
  'scheduled_tasks',
  'task_run_logs',
  'router_state',
  'sessions',
  'paired_projects',
  'paired_tasks',
  'paired_workspaces',
  'paired_turn_outputs',
  'paired_turn_reservations',
  'paired_turns',
  'paired_turn_attempts',
  'paired_task_execution_leases',
  'channel_owner',
  'room_settings',
  'room_role_overrides',
  'service_handoffs',
  'memories',
] as const;

function tableExists(
  database: Parameters<SchemaMigrationDefinition['apply']>[0],
  tableName: string,
): boolean {
  const row = database
    .prepare(
      `
        SELECT 1
          FROM sqlite_master
         WHERE type = 'table'
           AND name = ?
      `,
    )
    .get(tableName);
  return row !== null && row !== undefined;
}

function requiresLegacyBaseSchemaPreflight(
  database: Parameters<SchemaMigrationDefinition['apply']>[0],
): boolean {
  return LEGACY_BASELINE_TABLES.some(
    (tableName) => !tableExists(database, tableName),
  );
}

export const LEGACY_SCHEMA_BUNDLE_MIGRATION = {
  version: 1,
  name: 'legacy_schema_bundle',
  alwaysRun: true,
  apply(database, args) {
    // Some pre-versioned test and upgrade fixtures contain only a subset of the
    // current base tables. Re-establish the baseline before applying the legacy
    // monolithic upgrade bundle.
    if (requiresLegacyBaseSchemaPreflight(database)) {
      applyBaseSchema(database);
    }
    applyLegacySchemaMigrations(database, args);
  },
} satisfies SchemaMigrationDefinition;
