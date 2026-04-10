import { backfillPairedTurnAttemptsFromTurns } from '../paired-turn-attempts.js';
import {
  applyPairedTurnAttemptProvenanceConstraints,
  assertPairedTurnAttemptProvenanceIntegrity,
  backfillPairedTurnAttemptActiveRunIds,
  backfillPairedTurnAttemptEntityIds,
  backfillPairedTurnAttemptIds,
  backfillPairedTurnAttemptParentIds,
  backfillPairedTurnAttemptProvenance,
  dropPairedTurnAttemptProvenanceConstraints,
  rebuildPairedTurnAttemptForeignKeyTables,
  rebuildPairedTurnsWithoutLegacyScratchColumns,
} from '../paired-turn-provenance-schema.js';
import { tryExecMigration } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

export const PAIRED_TURN_PROVENANCE_UPGRADE_MIGRATION = {
  version: 10,
  name: 'paired_turn_provenance_upgrade',
  alwaysRun: true,
  apply(database) {
    tryExecMigration(
      database,
      `ALTER TABLE service_handoffs ADD COLUMN paired_task_id TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE service_handoffs ADD COLUMN paired_task_updated_at TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE service_handoffs ADD COLUMN turn_id TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE service_handoffs ADD COLUMN turn_attempt_id TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE service_handoffs ADD COLUMN turn_attempt_no INTEGER`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE service_handoffs ADD COLUMN turn_intent_kind TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE service_handoffs ADD COLUMN turn_role TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE paired_task_execution_leases ADD COLUMN turn_id TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE paired_task_execution_leases ADD COLUMN turn_attempt_id TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE paired_task_execution_leases ADD COLUMN turn_attempt_no INTEGER`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE paired_turn_attempts ADD COLUMN attempt_id TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE paired_turn_attempts ADD COLUMN parent_attempt_id TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE paired_turn_attempts ADD COLUMN parent_handoff_id INTEGER`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE paired_turn_attempts ADD COLUMN continuation_handoff_id INTEGER`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE paired_turn_attempts ADD COLUMN active_run_id TEXT`,
    );
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_paired_turn_attempts_parent_handoff_id
        ON paired_turn_attempts(parent_handoff_id)
    `);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_paired_turn_attempts_continuation_handoff_id
        ON paired_turn_attempts(continuation_handoff_id)
    `);
    tryExecMigration(
      database,
      `ALTER TABLE paired_turn_reservations ADD COLUMN turn_id TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE paired_turn_reservations ADD COLUMN turn_attempt_id TEXT`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE paired_turn_reservations ADD COLUMN turn_attempt_no INTEGER`,
    );
    tryExecMigration(
      database,
      `ALTER TABLE paired_turn_reservations ADD COLUMN turn_role TEXT`,
    );

    database.exec(`
      UPDATE paired_turn_reservations
         SET turn_id = COALESCE(
           turn_id,
           task_id || ':' || task_updated_at || ':' || intent_kind
         )
    `);
    database.exec(`
      UPDATE paired_turn_reservations
         SET turn_role = COALESCE(
           turn_role,
           CASE
             WHEN intent_kind = 'reviewer-turn' THEN 'reviewer'
             WHEN intent_kind = 'arbiter-turn' THEN 'arbiter'
             ELSE 'owner'
           END
         )
    `);
    database.exec(`
      UPDATE paired_task_execution_leases
         SET turn_id = COALESCE(
           turn_id,
           task_id || ':' || task_updated_at || ':' || intent_kind
         )
    `);
    database.exec(
      `UPDATE service_handoffs
       SET target_role = COALESCE(
         target_role,
         intended_role,
         CASE
           WHEN reason LIKE 'reviewer-%' THEN 'reviewer'
           WHEN reason LIKE 'arbiter-%' THEN 'arbiter'
           WHEN reason IS NOT NULL THEN 'owner'
           ELSE NULL
         END
       )
       WHERE target_role IS NULL`,
    );
    database.exec(
      `UPDATE service_handoffs
       SET source_role = COALESCE(source_role, target_role, intended_role)
       WHERE source_role IS NULL`,
    );
    database.exec(
      `UPDATE service_handoffs
       SET turn_role = COALESCE(turn_role, target_role, intended_role)
       WHERE turn_role IS NULL`,
    );
    database.exec(
      `UPDATE service_handoffs
       SET turn_intent_kind = COALESCE(
         turn_intent_kind,
         CASE
           WHEN turn_role = 'reviewer' THEN 'reviewer-turn'
           WHEN turn_role = 'arbiter' THEN 'arbiter-turn'
           ELSE turn_intent_kind
         END
       )`,
    );
    database.exec(
      `UPDATE service_handoffs
       SET turn_id = COALESCE(
         turn_id,
         CASE
           WHEN paired_task_id IS NOT NULL
            AND paired_task_updated_at IS NOT NULL
            AND turn_intent_kind IS NOT NULL
           THEN paired_task_id || ':' || paired_task_updated_at || ':' || turn_intent_kind
           ELSE turn_id
         END
       )`,
    );

    backfillPairedTurnAttemptsFromTurns(database);
    backfillPairedTurnAttemptIds(database);
    backfillPairedTurnAttemptParentIds(database);
    backfillPairedTurnAttemptActiveRunIds(database);
    backfillPairedTurnAttemptProvenance(database);
    backfillPairedTurnAttemptEntityIds(database);
    assertPairedTurnAttemptProvenanceIntegrity(database);
    dropPairedTurnAttemptProvenanceConstraints(database);
    rebuildPairedTurnsWithoutLegacyScratchColumns(database);
    rebuildPairedTurnAttemptForeignKeyTables(database);
    applyPairedTurnAttemptProvenanceConstraints(database);
  },
} satisfies SchemaMigrationDefinition;
