import { Database } from 'bun:sqlite';

import { buildPairedTurnAttemptId } from './paired-turn-attempts.js';
import { tableHasColumn } from './migrations/helpers.js';

// Paired-turn provenance rebuild helpers extracted from the legacy schema
// bundle. These remain runtime helpers because v10 replays them during
// initialization for pre-versioned and partially-migrated databases.

function getTableSql(database: Database, tableName: string): string | null {
  const row = database
    .prepare(
      `
        SELECT sql
          FROM sqlite_master
         WHERE type = 'table'
           AND name = ?
      `,
    )
    .get(tableName) as { sql?: string | null } | undefined;
  return row?.sql ?? null;
}

function buildPairedTurnAttemptIdSql(
  turnIdExpr: string,
  attemptNoExpr: string,
): string {
  return `${turnIdExpr} || ':attempt:' || CAST(${attemptNoExpr} AS TEXT)`;
}

function buildPairedTurnAttemptParentIdSql(
  turnIdExpr: string,
  attemptNoExpr: string,
): string {
  return `CASE
    WHEN ${attemptNoExpr} <= 1 THEN NULL
    ELSE ${buildPairedTurnAttemptIdSql(turnIdExpr, `(${attemptNoExpr}) - 1`)}
  END`;
}

function buildPairedTurnAttemptParentHandoffMatchSql(args: {
  parentHandoffIdExpr: string;
  turnIdExpr: string;
  parentAttemptIdExpr: string;
  attemptNoExpr: string;
}): string {
  return `EXISTS (
    SELECT 1
      FROM service_handoffs
     WHERE service_handoffs.id = ${args.parentHandoffIdExpr}
       AND service_handoffs.turn_id = ${args.turnIdExpr}
       AND service_handoffs.status = 'failed'
       AND (
         service_handoffs.turn_attempt_id = ${args.parentAttemptIdExpr}
         OR (
           service_handoffs.turn_attempt_id IS NULL
           AND service_handoffs.turn_attempt_no = (${args.attemptNoExpr}) - 1
         )
       )
  )`;
}

function buildPairedTurnAttemptContinuationHandoffMatchSql(args: {
  continuationHandoffIdExpr: string;
  turnIdExpr: string;
  attemptIdExpr: string;
  attemptNoExpr: string;
}): string {
  return `EXISTS (
    SELECT 1
      FROM service_handoffs
     WHERE service_handoffs.id = ${args.continuationHandoffIdExpr}
       AND service_handoffs.turn_id = ${args.turnIdExpr}
       AND (
         service_handoffs.turn_attempt_id = ${args.attemptIdExpr}
         OR (
           service_handoffs.turn_attempt_id IS NULL
           AND service_handoffs.turn_attempt_no = ${args.attemptNoExpr}
         )
       )
  )`;
}

function tableHasForeignKey(
  database: Database,
  args: {
    tableName: string;
    referencedTable: string;
    fromColumns: string[];
    toColumns: string[];
    onDelete?: string;
  },
): boolean {
  const rows = database
    .prepare(`PRAGMA foreign_key_list(${args.tableName})`)
    .all() as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (rows.length === 0) {
    return false;
  }

  const byId = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = byId.get(row.id) ?? [];
    group.push(row);
    byId.set(row.id, group);
  }

  for (const group of byId.values()) {
    const sorted = [...group].sort((left, right) => left.seq - right.seq);
    if (sorted.length !== args.fromColumns.length) {
      continue;
    }
    if (sorted[0]!.table !== args.referencedTable) {
      continue;
    }
    if (
      args.onDelete &&
      sorted[0]!.on_delete.toUpperCase() !== args.onDelete.toUpperCase()
    ) {
      continue;
    }

    const matches = sorted.every((row, index) => {
      return (
        row.from === args.fromColumns[index] && row.to === args.toColumns[index]
      );
    });
    if (matches) {
      return true;
    }
  }

  return false;
}

interface PairedTurnAttemptTimingRow {
  turn_id: string;
  attempt_no: number;
  created_at: string;
}

interface PairedTurnAttemptTiming {
  attemptNo: number;
  createdAtMs: number;
}

function parseBackfillTimestampMs(
  value: string | null | undefined,
): number | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(normalized)) {
    normalized = `${normalized}Z`;
  }

  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function getPairedTurnAttemptTimingsByTurnId(
  database: Database,
): Map<string, PairedTurnAttemptTiming[]> {
  const rows = database
    .prepare(
      `
        SELECT turn_id, attempt_no, created_at
          FROM paired_turn_attempts
         WHERE attempt_no >= 1
         ORDER BY turn_id ASC, attempt_no ASC
      `,
    )
    .all() as PairedTurnAttemptTimingRow[];
  const timingsByTurnId = new Map<string, PairedTurnAttemptTiming[]>();

  for (const row of rows) {
    const createdAtMs = parseBackfillTimestampMs(row.created_at);
    if (createdAtMs === null) {
      throw new Error(
        `paired_turn_attempts(${row.turn_id}, attempt=${row.attempt_no}) has an invalid created_at timestamp`,
      );
    }
    const timings = timingsByTurnId.get(row.turn_id) ?? [];
    timings.push({
      attemptNo: row.attempt_no,
      createdAtMs,
    });
    timingsByTurnId.set(row.turn_id, timings);
  }

  return timingsByTurnId;
}

function resolveAttemptNoForBackfill(
  args: {
    turnId: string;
    eventTimestamp: string | null | undefined;
    rowLabel: string;
  },
  timingsByTurnId: Map<string, PairedTurnAttemptTiming[]>,
): number | null {
  const attemptTimings = timingsByTurnId.get(args.turnId) ?? [];
  if (attemptTimings.length === 0) {
    return null;
  }

  if (attemptTimings.length === 1) {
    return attemptTimings[0]!.attemptNo;
  }

  const eventAtMs = parseBackfillTimestampMs(args.eventTimestamp);
  if (eventAtMs === null) {
    throw new Error(
      `${args.rowLabel} has turn_id=${args.turnId} but no timestamp that can be mapped to a specific attempt`,
    );
  }

  const exactMatches = attemptTimings.filter((timing, index) => {
    const nextTiming = attemptTimings[index + 1];
    return (
      eventAtMs >= timing.createdAtMs &&
      (nextTiming === undefined || eventAtMs < nextTiming.createdAtMs)
    );
  });
  if (exactMatches.length === 1) {
    return exactMatches[0]!.attemptNo;
  }
  if (exactMatches.length > 1) {
    throw new Error(
      `${args.rowLabel} has an ambiguous exact timestamp match for turn_id=${args.turnId}`,
    );
  }

  const eventAtSecond = Math.floor(eventAtMs / 1000);
  const secondPrecisionMatches = attemptTimings.filter((timing, index) => {
    const nextTiming = attemptTimings[index + 1];
    const timingSecond = Math.floor(timing.createdAtMs / 1000);
    const nextTimingSecond =
      nextTiming === undefined
        ? null
        : Math.floor(nextTiming.createdAtMs / 1000);
    return (
      eventAtSecond >= timingSecond &&
      (nextTimingSecond === null || eventAtSecond < nextTimingSecond)
    );
  });
  if (secondPrecisionMatches.length === 1) {
    return secondPrecisionMatches[0]!.attemptNo;
  }
  if (secondPrecisionMatches.length > 1) {
    throw new Error(
      `${args.rowLabel} has an ambiguous second-precision timestamp match for turn_id=${args.turnId}`,
    );
  }

  throw new Error(
    `${args.rowLabel} could not be mapped to a specific attempt for turn_id=${args.turnId}`,
  );
}

export function backfillPairedTurnAttemptIds(database: Database): void {
  if (!tableHasColumn(database, 'paired_turn_attempts', 'attempt_id')) {
    return;
  }

  database.exec(`
    UPDATE paired_turn_attempts
       SET attempt_id = ${buildPairedTurnAttemptIdSql('turn_id', 'attempt_no')}
     WHERE attempt_id IS NULL
        OR TRIM(attempt_id) = ''
  `);
}

export function backfillPairedTurnAttemptParentIds(database: Database): void {
  if (!tableHasColumn(database, 'paired_turn_attempts', 'parent_attempt_id')) {
    return;
  }

  database.exec(`
    UPDATE paired_turn_attempts
       SET parent_attempt_id = ${buildPairedTurnAttemptParentIdSql('turn_id', 'attempt_no')}
     WHERE attempt_no > 1
       AND EXISTS (
         SELECT 1
           FROM paired_turn_attempts previous_attempt
          WHERE previous_attempt.turn_id = paired_turn_attempts.turn_id
            AND previous_attempt.attempt_no = paired_turn_attempts.attempt_no - 1
       )
       AND (
         parent_attempt_id IS NULL
         OR TRIM(parent_attempt_id) = ''
         OR parent_attempt_id != ${buildPairedTurnAttemptParentIdSql('turn_id', 'attempt_no')}
       )
  `);

  database.exec(`
    UPDATE paired_turn_attempts
       SET parent_attempt_id = NULL
     WHERE attempt_no <= 1
       AND parent_attempt_id IS NOT NULL
  `);
}

export function backfillPairedTurnAttemptActiveRunIds(
  database: Database,
): void {
  if (!tableHasColumn(database, 'paired_turn_attempts', 'active_run_id')) {
    return;
  }

  const pairedTurnsActiveRunIdExists = tableHasColumn(
    database,
    'paired_turns',
    'active_run_id',
  );
  const leaseTurnIdExists = tableHasColumn(
    database,
    'paired_task_execution_leases',
    'turn_id',
  );
  const leaseTurnAttemptNoExists = tableHasColumn(
    database,
    'paired_task_execution_leases',
    'turn_attempt_no',
  );
  const leaseActiveRunIdSql = leaseTurnIdExists
    ? leaseTurnAttemptNoExists
      ? `COALESCE(
           (
             SELECT paired_task_execution_leases.claimed_run_id
               FROM paired_task_execution_leases
              WHERE paired_task_execution_leases.turn_id = paired_turn_attempts.turn_id
                AND paired_task_execution_leases.turn_attempt_no = paired_turn_attempts.attempt_no
              ORDER BY paired_task_execution_leases.updated_at DESC,
                       paired_task_execution_leases.claimed_at DESC
              LIMIT 1
           ),
           (
             SELECT paired_task_execution_leases.claimed_run_id
               FROM paired_task_execution_leases
              WHERE paired_task_execution_leases.turn_id = paired_turn_attempts.turn_id
                AND paired_task_execution_leases.turn_attempt_no IS NULL
              ORDER BY paired_task_execution_leases.updated_at DESC,
                       paired_task_execution_leases.claimed_at DESC
              LIMIT 1
           )
         )`
      : `(
           SELECT paired_task_execution_leases.claimed_run_id
             FROM paired_task_execution_leases
            WHERE paired_task_execution_leases.turn_id = paired_turn_attempts.turn_id
            ORDER BY paired_task_execution_leases.updated_at DESC,
                     paired_task_execution_leases.claimed_at DESC
            LIMIT 1
         )`
    : 'NULL';
  const legacyTurnActiveRunIdSql = pairedTurnsActiveRunIdExists
    ? `(
         SELECT paired_turns.active_run_id
           FROM paired_turns
          WHERE paired_turns.turn_id = paired_turn_attempts.turn_id
       )`
    : 'NULL';

  database.exec(`
    UPDATE paired_turn_attempts
       SET active_run_id = COALESCE(
         active_run_id,
         CASE
           WHEN state = 'running'
           THEN COALESCE(
             ${leaseActiveRunIdSql},
             ${legacyTurnActiveRunIdSql}
           )
           ELSE NULL
         END
       )
     WHERE state = 'running'
       AND (active_run_id IS NULL OR TRIM(active_run_id) = '')
  `);

  database.exec(`
    UPDATE paired_turn_attempts
       SET active_run_id = NULL
     WHERE state != 'running'
       AND active_run_id IS NOT NULL
  `);
}

export function backfillPairedTurnAttemptEntityIds(database: Database): void {
  if (
    tableHasColumn(database, 'paired_turn_reservations', 'turn_attempt_id') &&
    tableHasColumn(database, 'paired_turn_reservations', 'turn_attempt_no')
  ) {
    database.exec(`
      UPDATE paired_turn_reservations
         SET turn_attempt_id = (
           SELECT paired_turn_attempts.attempt_id
             FROM paired_turn_attempts
            WHERE paired_turn_attempts.turn_id = paired_turn_reservations.turn_id
              AND paired_turn_attempts.attempt_no = paired_turn_reservations.turn_attempt_no
         )
       WHERE turn_attempt_no IS NOT NULL
         AND (turn_attempt_id IS NULL OR TRIM(turn_attempt_id) = '')
    `);
  }

  if (
    tableHasColumn(
      database,
      'paired_task_execution_leases',
      'turn_attempt_id',
    ) &&
    tableHasColumn(database, 'paired_task_execution_leases', 'turn_attempt_no')
  ) {
    database.exec(`
      UPDATE paired_task_execution_leases
         SET turn_attempt_id = (
           SELECT paired_turn_attempts.attempt_id
             FROM paired_turn_attempts
            WHERE paired_turn_attempts.turn_id = paired_task_execution_leases.turn_id
              AND paired_turn_attempts.attempt_no = paired_task_execution_leases.turn_attempt_no
         )
       WHERE turn_attempt_no IS NOT NULL
         AND (turn_attempt_id IS NULL OR TRIM(turn_attempt_id) = '')
    `);
  }

  if (
    tableHasColumn(database, 'service_handoffs', 'turn_attempt_id') &&
    tableHasColumn(database, 'service_handoffs', 'turn_attempt_no')
  ) {
    database.exec(`
      UPDATE service_handoffs
         SET turn_attempt_id = (
           SELECT paired_turn_attempts.attempt_id
             FROM paired_turn_attempts
            WHERE paired_turn_attempts.turn_id = service_handoffs.turn_id
              AND paired_turn_attempts.attempt_no = service_handoffs.turn_attempt_no
         )
       WHERE turn_attempt_no IS NOT NULL
         AND (turn_attempt_id IS NULL OR TRIM(turn_attempt_id) = '')
    `);
  }
}

export function backfillPairedTurnAttemptProvenance(database: Database): void {
  const timingsByTurnId = getPairedTurnAttemptTimingsByTurnId(database);

  if (tableHasColumn(database, 'paired_turn_reservations', 'turn_attempt_no')) {
    const hasTurnAttemptIdColumn = tableHasColumn(
      database,
      'paired_turn_reservations',
      'turn_attempt_id',
    );
    const rows = database
      .prepare(
        `
          SELECT rowid, turn_id, status, created_at, updated_at, consumed_at
            FROM paired_turn_reservations
           WHERE turn_id IS NOT NULL
             AND turn_attempt_no IS NULL
        `,
      )
      .all() as Array<{
      rowid: number;
      turn_id: string;
      status: string;
      created_at: string | null;
      updated_at: string | null;
      consumed_at: string | null;
    }>;
    const update = hasTurnAttemptIdColumn
      ? database.prepare(
          'UPDATE paired_turn_reservations SET turn_attempt_id = ?, turn_attempt_no = ? WHERE rowid = ?',
        )
      : database.prepare(
          'UPDATE paired_turn_reservations SET turn_attempt_no = ? WHERE rowid = ?',
        );

    for (const row of rows) {
      if (row.status !== 'completed') {
        continue;
      }
      const attemptNo = resolveAttemptNoForBackfill(
        {
          turnId: row.turn_id,
          eventTimestamp: row.consumed_at ?? row.updated_at ?? row.created_at,
          rowLabel: `paired_turn_reservations(rowid=${row.rowid})`,
        },
        timingsByTurnId,
      );
      if (attemptNo !== null) {
        const attemptId = buildPairedTurnAttemptId(row.turn_id, attemptNo);
        if (hasTurnAttemptIdColumn) {
          update.run(attemptId, attemptNo, row.rowid);
        } else {
          update.run(attemptNo, row.rowid);
        }
      }
    }
  }

  if (
    tableHasColumn(database, 'paired_task_execution_leases', 'turn_attempt_no')
  ) {
    const hasTurnAttemptIdColumn = tableHasColumn(
      database,
      'paired_task_execution_leases',
      'turn_attempt_id',
    );
    const rows = database
      .prepare(
        `
          SELECT rowid, turn_id, claimed_at, updated_at
            FROM paired_task_execution_leases
           WHERE turn_id IS NOT NULL
             AND turn_attempt_no IS NULL
        `,
      )
      .all() as Array<{
      rowid: number;
      turn_id: string;
      claimed_at: string | null;
      updated_at: string | null;
    }>;
    const update = hasTurnAttemptIdColumn
      ? database.prepare(
          'UPDATE paired_task_execution_leases SET turn_attempt_id = ?, turn_attempt_no = ? WHERE rowid = ?',
        )
      : database.prepare(
          'UPDATE paired_task_execution_leases SET turn_attempt_no = ? WHERE rowid = ?',
        );

    for (const row of rows) {
      const attemptNo = resolveAttemptNoForBackfill(
        {
          turnId: row.turn_id,
          eventTimestamp: row.updated_at ?? row.claimed_at,
          rowLabel: `paired_task_execution_leases(rowid=${row.rowid})`,
        },
        timingsByTurnId,
      );
      if (attemptNo !== null) {
        const attemptId = buildPairedTurnAttemptId(row.turn_id, attemptNo);
        if (hasTurnAttemptIdColumn) {
          update.run(attemptId, attemptNo, row.rowid);
        } else {
          update.run(attemptNo, row.rowid);
        }
      }
    }
  }

  if (tableHasColumn(database, 'service_handoffs', 'turn_attempt_no')) {
    const hasTurnAttemptIdColumn = tableHasColumn(
      database,
      'service_handoffs',
      'turn_attempt_id',
    );
    const rows = database
      .prepare(
        `
          SELECT id, turn_id, created_at, claimed_at, completed_at
            FROM service_handoffs
           WHERE turn_id IS NOT NULL
             AND turn_attempt_no IS NULL
        `,
      )
      .all() as Array<{
      id: number;
      turn_id: string;
      created_at: string | null;
      claimed_at: string | null;
      completed_at: string | null;
    }>;
    const update = hasTurnAttemptIdColumn
      ? database.prepare(
          'UPDATE service_handoffs SET turn_attempt_id = ?, turn_attempt_no = ? WHERE id = ?',
        )
      : database.prepare(
          'UPDATE service_handoffs SET turn_attempt_no = ? WHERE id = ?',
        );

    for (const row of rows) {
      const attemptNo = resolveAttemptNoForBackfill(
        {
          turnId: row.turn_id,
          eventTimestamp: row.completed_at ?? row.claimed_at ?? row.created_at,
          rowLabel: `service_handoffs(id=${row.id})`,
        },
        timingsByTurnId,
      );
      if (attemptNo !== null) {
        const attemptId = buildPairedTurnAttemptId(row.turn_id, attemptNo);
        if (hasTurnAttemptIdColumn) {
          update.run(attemptId, attemptNo, row.id);
        } else {
          update.run(attemptNo, row.id);
        }
      }
    }
  }
}

export function assertPairedTurnAttemptProvenanceIntegrity(
  database: Database,
): void {
  if (tableHasColumn(database, 'paired_turn_attempts', 'attempt_id')) {
    const invalidAttemptIdRow = database
      .prepare(
        `
          SELECT turn_id, attempt_no, attempt_id
            FROM paired_turn_attempts
           WHERE attempt_id IS NULL
              OR attempt_id != ${buildPairedTurnAttemptIdSql('turn_id', 'attempt_no')}
           LIMIT 1
        `,
      )
      .get() as
      | {
          turn_id: string;
          attempt_no: number;
          attempt_id: string | null;
        }
      | undefined;
    if (invalidAttemptIdRow) {
      throw new Error(
        `paired_turn_attempts(${invalidAttemptIdRow.turn_id}, attempt=${invalidAttemptIdRow.attempt_no}) has invalid attempt_id provenance`,
      );
    }
  }

  if (tableHasColumn(database, 'paired_turn_attempts', 'parent_attempt_id')) {
    const invalidParentAttemptRow = database
      .prepare(
        `
          SELECT turn_id, attempt_no, parent_attempt_id
            FROM paired_turn_attempts
           WHERE (
               attempt_no <= 1
               AND parent_attempt_id IS NOT NULL
             )
              OR (
                attempt_no > 1
                AND NOT EXISTS (
                  SELECT 1
                    FROM paired_turn_attempts previous_attempt
                   WHERE previous_attempt.turn_id = paired_turn_attempts.turn_id
                     AND previous_attempt.attempt_no = paired_turn_attempts.attempt_no - 1
                )
              )
              OR (
                attempt_no > 1
                AND (
                  parent_attempt_id IS NULL
                  OR parent_attempt_id != ${buildPairedTurnAttemptParentIdSql('turn_id', 'attempt_no')}
                  OR NOT EXISTS (
                    SELECT 1
                      FROM paired_turn_attempts previous_attempt
                     WHERE COALESCE(
                             previous_attempt.attempt_id,
                             ${buildPairedTurnAttemptIdSql(
                               'previous_attempt.turn_id',
                               'previous_attempt.attempt_no',
                             )}
                           ) = paired_turn_attempts.parent_attempt_id
                       AND previous_attempt.turn_id = paired_turn_attempts.turn_id
                       AND previous_attempt.attempt_no = paired_turn_attempts.attempt_no - 1
                  )
                )
              )
           LIMIT 1
        `,
      )
      .get() as
      | {
          turn_id: string;
          attempt_no: number;
          parent_attempt_id: string | null;
        }
      | undefined;
    if (invalidParentAttemptRow) {
      throw new Error(
        `paired_turn_attempts(${invalidParentAttemptRow.turn_id}, attempt=${invalidParentAttemptRow.attempt_no}) has invalid parent_attempt_id provenance`,
      );
    }
  }

  if (tableHasColumn(database, 'paired_turn_attempts', 'parent_handoff_id')) {
    const invalidParentHandoffRow = database
      .prepare(
        `
          SELECT turn_id, attempt_no, parent_handoff_id
            FROM paired_turn_attempts
           WHERE parent_handoff_id IS NOT NULL
             AND (
               attempt_no <= 1
               OR NOT ${buildPairedTurnAttemptParentHandoffMatchSql({
                 parentHandoffIdExpr: 'paired_turn_attempts.parent_handoff_id',
                 turnIdExpr: 'paired_turn_attempts.turn_id',
                 parentAttemptIdExpr: 'paired_turn_attempts.parent_attempt_id',
                 attemptNoExpr: 'paired_turn_attempts.attempt_no',
               })}
             )
           LIMIT 1
        `,
      )
      .get() as
      | {
          turn_id: string;
          attempt_no: number;
          parent_handoff_id: number | null;
        }
      | undefined;
    if (invalidParentHandoffRow) {
      throw new Error(
        `paired_turn_attempts(${invalidParentHandoffRow.turn_id}, attempt=${invalidParentHandoffRow.attempt_no}) has invalid parent_handoff_id provenance`,
      );
    }
  }

  if (
    tableHasColumn(database, 'paired_turn_attempts', 'continuation_handoff_id')
  ) {
    const invalidContinuationHandoffRow = database
      .prepare(
        `
          SELECT turn_id, attempt_no, continuation_handoff_id
            FROM paired_turn_attempts
           WHERE continuation_handoff_id IS NOT NULL
             AND NOT ${buildPairedTurnAttemptContinuationHandoffMatchSql({
               continuationHandoffIdExpr:
                 'paired_turn_attempts.continuation_handoff_id',
               turnIdExpr: 'paired_turn_attempts.turn_id',
               attemptIdExpr:
                 "COALESCE(paired_turn_attempts.attempt_id, paired_turn_attempts.turn_id || ':attempt:' || CAST(paired_turn_attempts.attempt_no AS TEXT))",
               attemptNoExpr: 'paired_turn_attempts.attempt_no',
             })}
           LIMIT 1
        `,
      )
      .get() as
      | {
          turn_id: string;
          attempt_no: number;
          continuation_handoff_id: number | null;
        }
      | undefined;
    if (invalidContinuationHandoffRow) {
      throw new Error(
        `paired_turn_attempts(${invalidContinuationHandoffRow.turn_id}, attempt=${invalidContinuationHandoffRow.attempt_no}) has invalid continuation_handoff_id provenance`,
      );
    }
  }

  const invalidAttemptRow = database
    .prepare(
      `
        SELECT turn_id, attempt_no
          FROM paired_turn_attempts
         WHERE NOT EXISTS (
           SELECT 1
             FROM paired_turns
            WHERE paired_turns.turn_id = paired_turn_attempts.turn_id
              AND paired_turns.task_id = paired_turn_attempts.task_id
              AND paired_turns.task_updated_at = paired_turn_attempts.task_updated_at
              AND paired_turns.role = paired_turn_attempts.role
              AND paired_turns.intent_kind = paired_turn_attempts.intent_kind
         )
         LIMIT 1
      `,
    )
    .get() as
    | {
        turn_id: string;
        attempt_no: number;
      }
    | undefined;
  if (invalidAttemptRow) {
    throw new Error(
      `paired_turn_attempts(${invalidAttemptRow.turn_id}, attempt=${invalidAttemptRow.attempt_no}) does not match its paired_turns identity`,
    );
  }

  if (tableHasColumn(database, 'paired_turn_attempts', 'active_run_id')) {
    const invalidAttemptActiveRunRow = database
      .prepare(
        `
          SELECT turn_id, attempt_no
            FROM paired_turn_attempts
           WHERE (
               state = 'running'
               AND (
                 active_run_id IS NULL
                 OR TRIM(active_run_id) = ''
               )
             )
              OR (
                state != 'running'
                AND active_run_id IS NOT NULL
              )
           LIMIT 1
        `,
      )
      .get() as
      | {
          turn_id: string;
          attempt_no: number;
        }
      | undefined;
    if (invalidAttemptActiveRunRow) {
      throw new Error(
        `paired_turn_attempts(${invalidAttemptActiveRunRow.turn_id}, attempt=${invalidAttemptActiveRunRow.attempt_no}) has invalid active_run_id provenance`,
      );
    }
  }

  if (tableHasColumn(database, 'paired_turn_reservations', 'turn_attempt_no')) {
    const invalidReservation = database
      .prepare(
        `
          SELECT rowid
            FROM paired_turn_reservations
           WHERE turn_attempt_no IS NOT NULL
             AND (
               turn_id IS NULL
               OR (turn_attempt_id IS NULL AND ${tableHasColumn(database, 'paired_turn_reservations', 'turn_attempt_id') ? '1 = 1' : '0 = 1'})
               OR NOT EXISTS (
                 SELECT 1
                   FROM paired_turn_attempts
                  WHERE paired_turn_attempts.turn_id = paired_turn_reservations.turn_id
                    AND paired_turn_attempts.attempt_no = paired_turn_reservations.turn_attempt_no
                    ${
                      tableHasColumn(
                        database,
                        'paired_turn_reservations',
                        'turn_attempt_id',
                      )
                        ? 'AND paired_turn_attempts.attempt_id = paired_turn_reservations.turn_attempt_id'
                        : ''
                    }
                    AND paired_turn_attempts.task_id = paired_turn_reservations.task_id
                    AND paired_turn_attempts.task_updated_at = paired_turn_reservations.task_updated_at
                    AND paired_turn_attempts.role = paired_turn_reservations.turn_role
                    AND paired_turn_attempts.intent_kind = paired_turn_reservations.intent_kind
               )
             )
           LIMIT 1
        `,
      )
      .get() as { rowid: number } | undefined;
    if (invalidReservation) {
      throw new Error(
        `paired_turn_reservations(rowid=${invalidReservation.rowid}) has invalid paired_turn_attempt provenance`,
      );
    }
  }

  if (
    tableHasColumn(database, 'paired_task_execution_leases', 'turn_attempt_no')
  ) {
    const invalidLease = database
      .prepare(
        `
          SELECT rowid
            FROM paired_task_execution_leases
           WHERE turn_attempt_no IS NOT NULL
             AND (
               turn_id IS NULL
               OR (turn_attempt_id IS NULL AND ${tableHasColumn(database, 'paired_task_execution_leases', 'turn_attempt_id') ? '1 = 1' : '0 = 1'})
               OR NOT EXISTS (
                 SELECT 1
                   FROM paired_turn_attempts
                  WHERE paired_turn_attempts.turn_id = paired_task_execution_leases.turn_id
                    AND paired_turn_attempts.attempt_no = paired_task_execution_leases.turn_attempt_no
                    ${
                      tableHasColumn(
                        database,
                        'paired_task_execution_leases',
                        'turn_attempt_id',
                      )
                        ? 'AND paired_turn_attempts.attempt_id = paired_task_execution_leases.turn_attempt_id'
                        : ''
                    }
                    AND paired_turn_attempts.task_id = paired_task_execution_leases.task_id
                    AND paired_turn_attempts.task_updated_at = paired_task_execution_leases.task_updated_at
                    AND paired_turn_attempts.role = paired_task_execution_leases.role
                    AND paired_turn_attempts.intent_kind = paired_task_execution_leases.intent_kind
               )
             )
           LIMIT 1
        `,
      )
      .get() as { rowid: number } | undefined;
    if (invalidLease) {
      throw new Error(
        `paired_task_execution_leases(rowid=${invalidLease.rowid}) has invalid paired_turn_attempt provenance`,
      );
    }
  }

  if (tableHasColumn(database, 'service_handoffs', 'turn_attempt_no')) {
    const invalidHandoff = database
      .prepare(
        `
          SELECT id
            FROM service_handoffs
           WHERE turn_attempt_no IS NOT NULL
             AND (
               turn_id IS NULL
               OR (turn_attempt_id IS NULL AND ${tableHasColumn(database, 'service_handoffs', 'turn_attempt_id') ? '1 = 1' : '0 = 1'})
               OR paired_task_id IS NULL
               OR paired_task_updated_at IS NULL
               OR turn_role IS NULL
               OR turn_intent_kind IS NULL
               OR NOT EXISTS (
                 SELECT 1
                   FROM paired_turn_attempts
                  WHERE paired_turn_attempts.turn_id = service_handoffs.turn_id
                    AND paired_turn_attempts.attempt_no = service_handoffs.turn_attempt_no
                    ${
                      tableHasColumn(
                        database,
                        'service_handoffs',
                        'turn_attempt_id',
                      )
                        ? 'AND paired_turn_attempts.attempt_id = service_handoffs.turn_attempt_id'
                        : ''
                    }
                    AND paired_turn_attempts.task_id = service_handoffs.paired_task_id
                    AND paired_turn_attempts.task_updated_at = service_handoffs.paired_task_updated_at
                    AND paired_turn_attempts.role = service_handoffs.turn_role
                    AND paired_turn_attempts.intent_kind = service_handoffs.turn_intent_kind
               )
             )
           LIMIT 1
        `,
      )
      .get() as { id: number } | undefined;
    if (invalidHandoff) {
      throw new Error(
        `service_handoffs(id=${invalidHandoff.id}) has invalid paired_turn_attempt provenance`,
      );
    }
  }
}

function rebuildPairedTurnAttemptsWithForeignKeys(database: Database): void {
  const tableSql = getTableSql(database, 'paired_turn_attempts') ?? '';
  if (
    tableHasColumn(database, 'paired_turn_attempts', 'attempt_id') &&
    tableHasColumn(database, 'paired_turn_attempts', 'parent_attempt_id') &&
    tableHasColumn(database, 'paired_turn_attempts', 'parent_handoff_id') &&
    tableHasColumn(
      database,
      'paired_turn_attempts',
      'continuation_handoff_id',
    ) &&
    tableSql.includes('attempt_id TEXT NOT NULL PRIMARY KEY') &&
    tableSql.includes('parent_attempt_id TEXT') &&
    tableSql.includes('parent_handoff_id INTEGER') &&
    tableSql.includes('continuation_handoff_id INTEGER') &&
    tableSql.includes('UNIQUE (turn_id, attempt_no)') &&
    tableHasForeignKey(database, {
      tableName: 'paired_turn_attempts',
      referencedTable: 'paired_turn_attempts',
      fromColumns: ['parent_attempt_id'],
      toColumns: ['attempt_id'],
      onDelete: 'CASCADE',
    }) &&
    tableHasForeignKey(database, {
      tableName: 'paired_turn_attempts',
      referencedTable: 'service_handoffs',
      fromColumns: ['parent_handoff_id'],
      toColumns: ['id'],
      onDelete: 'SET NULL',
    }) &&
    tableHasForeignKey(database, {
      tableName: 'paired_turn_attempts',
      referencedTable: 'service_handoffs',
      fromColumns: ['continuation_handoff_id'],
      toColumns: ['id'],
      onDelete: 'SET NULL',
    }) &&
    tableHasForeignKey(database, {
      tableName: 'paired_turn_attempts',
      referencedTable: 'paired_turns',
      fromColumns: ['turn_id'],
      toColumns: ['turn_id'],
      onDelete: 'CASCADE',
    })
  ) {
    return;
  }

  const parentAttemptIdSelectSql = tableHasColumn(
    database,
    'paired_turn_attempts',
    'parent_attempt_id',
  )
    ? `COALESCE(
        parent_attempt_id,
        CASE
          WHEN attempt_no > 1
           AND EXISTS (
             SELECT 1
               FROM paired_turn_attempts previous_attempt
              WHERE previous_attempt.turn_id = paired_turn_attempts.turn_id
                AND previous_attempt.attempt_no = paired_turn_attempts.attempt_no - 1
           )
          THEN ${buildPairedTurnAttemptParentIdSql('turn_id', 'attempt_no')}
          ELSE NULL
        END
      )`
    : `CASE
        WHEN attempt_no > 1
         AND EXISTS (
           SELECT 1
             FROM paired_turn_attempts previous_attempt
            WHERE previous_attempt.turn_id = paired_turn_attempts.turn_id
              AND previous_attempt.attempt_no = paired_turn_attempts.attempt_no - 1
         )
        THEN ${buildPairedTurnAttemptParentIdSql('turn_id', 'attempt_no')}
        ELSE NULL
      END`;
  const parentHandoffIdSelectSql = tableHasColumn(
    database,
    'paired_turn_attempts',
    'parent_handoff_id',
  )
    ? 'parent_handoff_id'
    : 'NULL';
  const continuationHandoffIdSelectSql = tableHasColumn(
    database,
    'paired_turn_attempts',
    'continuation_handoff_id',
  )
    ? 'continuation_handoff_id'
    : 'NULL';
  const activeRunIdSelectSql = tableHasColumn(
    database,
    'paired_turn_attempts',
    'active_run_id',
  )
    ? `CASE
        WHEN state = 'running' THEN active_run_id
        ELSE NULL
      END`
    : `CASE
        WHEN state = 'running'
        THEN ${
          tableHasColumn(database, 'paired_turns', 'active_run_id')
            ? `COALESCE(
                 ${
                   tableHasColumn(
                     database,
                     'paired_task_execution_leases',
                     'turn_attempt_no',
                   )
                     ? `COALESCE(
                        (
                          SELECT paired_task_execution_leases.claimed_run_id
                            FROM paired_task_execution_leases
                           WHERE paired_task_execution_leases.turn_id = paired_turn_attempts.turn_id
                             AND paired_task_execution_leases.turn_attempt_no = paired_turn_attempts.attempt_no
                           ORDER BY paired_task_execution_leases.updated_at DESC,
                                    paired_task_execution_leases.claimed_at DESC
                           LIMIT 1
                        ),
                        (
                          SELECT paired_task_execution_leases.claimed_run_id
                            FROM paired_task_execution_leases
                           WHERE paired_task_execution_leases.turn_id = paired_turn_attempts.turn_id
                             AND paired_task_execution_leases.turn_attempt_no IS NULL
                           ORDER BY paired_task_execution_leases.updated_at DESC,
                                    paired_task_execution_leases.claimed_at DESC
                           LIMIT 1
                        )
                      )`
                     : `(
                        SELECT paired_task_execution_leases.claimed_run_id
                         FROM paired_task_execution_leases
                         WHERE paired_task_execution_leases.turn_id = paired_turn_attempts.turn_id
                         ORDER BY paired_task_execution_leases.updated_at DESC,
                                  paired_task_execution_leases.claimed_at DESC
                         LIMIT 1
                      )`
                 },
                 (
                   SELECT paired_turns.active_run_id
                     FROM paired_turns
                    WHERE paired_turns.turn_id = paired_turn_attempts.turn_id
                 )
               )`
            : `(
                 ${
                   tableHasColumn(
                     database,
                     'paired_task_execution_leases',
                     'turn_attempt_no',
                   )
                     ? `COALESCE(
                          (
                            SELECT paired_task_execution_leases.claimed_run_id
                              FROM paired_task_execution_leases
                             WHERE paired_task_execution_leases.turn_id = paired_turn_attempts.turn_id
                               AND paired_task_execution_leases.turn_attempt_no = paired_turn_attempts.attempt_no
                             ORDER BY paired_task_execution_leases.updated_at DESC,
                                      paired_task_execution_leases.claimed_at DESC
                             LIMIT 1
                          ),
                          (
                            SELECT paired_task_execution_leases.claimed_run_id
                              FROM paired_task_execution_leases
                             WHERE paired_task_execution_leases.turn_id = paired_turn_attempts.turn_id
                               AND paired_task_execution_leases.turn_attempt_no IS NULL
                             ORDER BY paired_task_execution_leases.updated_at DESC,
                                      paired_task_execution_leases.claimed_at DESC
                             LIMIT 1
                          )
                        )`
                     : `(
                          SELECT paired_task_execution_leases.claimed_run_id
                            FROM paired_task_execution_leases
                           WHERE paired_task_execution_leases.turn_id = paired_turn_attempts.turn_id
                           ORDER BY paired_task_execution_leases.updated_at DESC,
                                    paired_task_execution_leases.claimed_at DESC
                           LIMIT 1
                        )`
                 }`
        }
        ELSE NULL
      END`;

  database.transaction(() => {
    database.exec(`
      CREATE TABLE paired_turn_attempts_new (
        attempt_id TEXT NOT NULL PRIMARY KEY,
        parent_attempt_id TEXT,
        parent_handoff_id INTEGER,
        continuation_handoff_id INTEGER,
        turn_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        task_updated_at TEXT NOT NULL,
        role TEXT NOT NULL,
        intent_kind TEXT NOT NULL,
        state TEXT NOT NULL,
        executor_service_id TEXT,
        executor_agent_type TEXT,
        active_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        last_error TEXT,
        UNIQUE (turn_id, attempt_no),
        FOREIGN KEY (parent_attempt_id)
          REFERENCES paired_turn_attempts_new(attempt_id)
          ON DELETE CASCADE,
        FOREIGN KEY (parent_handoff_id)
          REFERENCES service_handoffs(id)
          ON DELETE SET NULL,
        FOREIGN KEY (continuation_handoff_id)
          REFERENCES service_handoffs(id)
          ON DELETE SET NULL,
        FOREIGN KEY (turn_id) REFERENCES paired_turns(turn_id) ON DELETE CASCADE,
        CHECK (role IN ('owner', 'reviewer', 'arbiter')),
        CHECK (
          intent_kind IN (
            'owner-turn',
            'reviewer-turn',
            'arbiter-turn',
            'owner-follow-up',
            'finalize-owner-turn'
          )
        ),
        CHECK (
          state IN (
            'running',
            'delegated',
            'completed',
            'failed',
            'cancelled'
          )
        ),
        CHECK (executor_agent_type IN ('claude-code', 'codex') OR executor_agent_type IS NULL)
      );
      INSERT INTO paired_turn_attempts_new (
        attempt_id,
        parent_attempt_id,
        parent_handoff_id,
        continuation_handoff_id,
        turn_id,
        attempt_no,
        task_id,
        task_updated_at,
        role,
        intent_kind,
        state,
        executor_service_id,
        executor_agent_type,
        active_run_id,
        created_at,
        updated_at,
        completed_at,
        last_error
      )
      SELECT
        COALESCE(attempt_id, ${buildPairedTurnAttemptIdSql('turn_id', 'attempt_no')}),
        ${parentAttemptIdSelectSql},
        ${parentHandoffIdSelectSql},
        ${continuationHandoffIdSelectSql},
        turn_id,
        attempt_no,
        task_id,
        task_updated_at,
        role,
        intent_kind,
        state,
        executor_service_id,
        executor_agent_type,
        ${activeRunIdSelectSql},
        created_at,
        updated_at,
        completed_at,
        last_error
      FROM paired_turn_attempts
      ORDER BY turn_id ASC, attempt_no ASC;
      DROP TABLE paired_turn_attempts;
      ALTER TABLE paired_turn_attempts_new RENAME TO paired_turn_attempts;
      CREATE INDEX IF NOT EXISTS idx_paired_turn_attempts_attempt_id
        ON paired_turn_attempts(attempt_id);
      CREATE INDEX IF NOT EXISTS idx_paired_turn_attempts_parent_attempt_id
        ON paired_turn_attempts(parent_attempt_id);
      CREATE INDEX IF NOT EXISTS idx_paired_turn_attempts_parent_handoff_id
        ON paired_turn_attempts(parent_handoff_id);
      CREATE INDEX IF NOT EXISTS idx_paired_turn_attempts_continuation_handoff_id
        ON paired_turn_attempts(continuation_handoff_id);
      CREATE INDEX IF NOT EXISTS idx_paired_turn_attempts_turn
        ON paired_turn_attempts(turn_id, attempt_no);
      CREATE INDEX IF NOT EXISTS idx_paired_turn_attempts_task
        ON paired_turn_attempts(task_id, task_updated_at, attempt_no);
    `);
  })();
}

export function rebuildPairedTurnsWithoutLegacyScratchColumns(
  database: Database,
): void {
  if (
    !tableHasColumn(database, 'paired_turns', 'next_parent_handoff_id') &&
    !tableHasColumn(database, 'paired_turns', 'active_run_id') &&
    !tableHasColumn(database, 'paired_turns', 'state') &&
    !tableHasColumn(database, 'paired_turns', 'executor_service_id') &&
    !tableHasColumn(database, 'paired_turns', 'executor_agent_type') &&
    !tableHasColumn(database, 'paired_turns', 'attempt_no') &&
    !tableHasColumn(database, 'paired_turns', 'completed_at') &&
    !tableHasColumn(database, 'paired_turns', 'last_error')
  ) {
    return;
  }

  database.transaction(() => {
    database.exec(`
      CREATE TABLE paired_turns_new (
        turn_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_updated_at TEXT NOT NULL,
        role TEXT NOT NULL,
        intent_kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (role IN ('owner', 'reviewer', 'arbiter')),
        CHECK (
          intent_kind IN (
            'owner-turn',
            'reviewer-turn',
            'arbiter-turn',
            'owner-follow-up',
            'finalize-owner-turn'
          )
        )
      );
      INSERT INTO paired_turns_new (
        turn_id,
        task_id,
        task_updated_at,
        role,
        intent_kind,
        created_at,
        updated_at
      )
      SELECT
        turn_id,
        task_id,
        task_updated_at,
        role,
        intent_kind,
        created_at,
        updated_at
      FROM paired_turns
      ORDER BY created_at ASC, turn_id ASC;
      DROP TABLE paired_turns;
      ALTER TABLE paired_turns_new RENAME TO paired_turns;
      CREATE INDEX IF NOT EXISTS idx_paired_turns_task
        ON paired_turns(task_id, task_updated_at, updated_at);
    `);
  })();
}

function rebuildPairedTurnReservationsWithForeignKeys(
  database: Database,
): void {
  if (
    !tableHasColumn(database, 'paired_turn_reservations', 'turn_attempt_no') ||
    (tableHasForeignKey(database, {
      tableName: 'paired_turn_reservations',
      referencedTable: 'paired_turn_attempts',
      fromColumns: ['turn_id', 'turn_attempt_no'],
      toColumns: ['turn_id', 'attempt_no'],
      onDelete: 'CASCADE',
    }) &&
      tableHasColumn(database, 'paired_turn_reservations', 'turn_attempt_id') &&
      tableHasForeignKey(database, {
        tableName: 'paired_turn_reservations',
        referencedTable: 'paired_turn_attempts',
        fromColumns: ['turn_attempt_id'],
        toColumns: ['attempt_id'],
        onDelete: 'CASCADE',
      }))
  ) {
    return;
  }

  database.transaction(() => {
    database.exec(`
      CREATE TABLE paired_turn_reservations_new (
        chat_jid TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_status TEXT NOT NULL,
        round_trip_count INTEGER NOT NULL DEFAULT 0,
        task_updated_at TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        turn_attempt_id TEXT,
        turn_attempt_no INTEGER,
        turn_role TEXT NOT NULL,
        intent_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        scheduled_run_id TEXT,
        consumed_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        consumed_at TEXT,
        PRIMARY KEY (chat_jid, task_id, task_updated_at, intent_kind),
        FOREIGN KEY (turn_attempt_id)
          REFERENCES paired_turn_attempts(attempt_id)
          ON DELETE CASCADE,
        FOREIGN KEY (turn_id, turn_attempt_no)
          REFERENCES paired_turn_attempts(turn_id, attempt_no)
          ON DELETE CASCADE,
        CHECK (status IN ('pending', 'completed')),
        CHECK (turn_role IN ('owner', 'reviewer', 'arbiter')),
        CHECK (
          intent_kind IN (
            'owner-turn',
            'reviewer-turn',
            'arbiter-turn',
            'owner-follow-up',
            'finalize-owner-turn'
          )
        )
      );
      INSERT INTO paired_turn_reservations_new (
        chat_jid,
        task_id,
        task_status,
        round_trip_count,
        task_updated_at,
        turn_id,
        turn_attempt_id,
        turn_attempt_no,
        turn_role,
        intent_kind,
        status,
        scheduled_run_id,
        consumed_run_id,
        created_at,
        updated_at,
        consumed_at
      )
      SELECT
        chat_jid,
        task_id,
        task_status,
        round_trip_count,
        task_updated_at,
        turn_id,
        COALESCE(
          turn_attempt_id,
          CASE
            WHEN turn_attempt_no IS NOT NULL
            THEN ${buildPairedTurnAttemptIdSql('turn_id', 'turn_attempt_no')}
            ELSE NULL
          END
        ),
        turn_attempt_no,
        turn_role,
        intent_kind,
        status,
        scheduled_run_id,
        consumed_run_id,
        created_at,
        updated_at,
        consumed_at
      FROM paired_turn_reservations;
      DROP TABLE paired_turn_reservations;
      ALTER TABLE paired_turn_reservations_new RENAME TO paired_turn_reservations;
      CREATE INDEX IF NOT EXISTS idx_paired_turn_reservations_task
        ON paired_turn_reservations(task_id, task_updated_at, status);
    `);
  })();
}

function rebuildPairedTaskExecutionLeasesWithForeignKeys(
  database: Database,
): void {
  if (
    !tableHasColumn(
      database,
      'paired_task_execution_leases',
      'turn_attempt_no',
    ) ||
    (tableHasForeignKey(database, {
      tableName: 'paired_task_execution_leases',
      referencedTable: 'paired_turn_attempts',
      fromColumns: ['turn_id', 'turn_attempt_no'],
      toColumns: ['turn_id', 'attempt_no'],
      onDelete: 'CASCADE',
    }) &&
      tableHasColumn(
        database,
        'paired_task_execution_leases',
        'turn_attempt_id',
      ) &&
      tableHasForeignKey(database, {
        tableName: 'paired_task_execution_leases',
        referencedTable: 'paired_turn_attempts',
        fromColumns: ['turn_attempt_id'],
        toColumns: ['attempt_id'],
        onDelete: 'CASCADE',
      }))
  ) {
    return;
  }

  database.transaction(() => {
    database.exec(`
      CREATE TABLE paired_task_execution_leases_new (
        task_id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        role TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        turn_attempt_id TEXT,
        turn_attempt_no INTEGER,
        intent_kind TEXT NOT NULL,
        claimed_run_id TEXT NOT NULL,
        claimed_service_id TEXT NOT NULL,
        task_status TEXT NOT NULL,
        task_updated_at TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (turn_attempt_id)
          REFERENCES paired_turn_attempts(attempt_id)
          ON DELETE CASCADE,
        FOREIGN KEY (turn_id, turn_attempt_no)
          REFERENCES paired_turn_attempts(turn_id, attempt_no)
          ON DELETE CASCADE,
        CHECK (role IN ('owner', 'reviewer', 'arbiter')),
        CHECK (
          intent_kind IN (
            'owner-turn',
            'reviewer-turn',
            'arbiter-turn',
            'owner-follow-up',
            'finalize-owner-turn'
          )
        )
      );
      INSERT INTO paired_task_execution_leases_new (
        task_id,
        chat_jid,
        role,
        turn_id,
        turn_attempt_id,
        turn_attempt_no,
        intent_kind,
        claimed_run_id,
        claimed_service_id,
        task_status,
        task_updated_at,
        claimed_at,
        updated_at,
        expires_at
      )
      SELECT
        task_id,
        chat_jid,
        role,
        turn_id,
        COALESCE(
          turn_attempt_id,
          CASE
            WHEN turn_attempt_no IS NOT NULL
            THEN ${buildPairedTurnAttemptIdSql('turn_id', 'turn_attempt_no')}
            ELSE NULL
          END
        ),
        turn_attempt_no,
        intent_kind,
        claimed_run_id,
        claimed_service_id,
        task_status,
        task_updated_at,
        claimed_at,
        updated_at,
        expires_at
      FROM paired_task_execution_leases;
      DROP TABLE paired_task_execution_leases;
      ALTER TABLE paired_task_execution_leases_new RENAME TO paired_task_execution_leases;
      CREATE INDEX IF NOT EXISTS idx_paired_task_execution_leases_expires_at
        ON paired_task_execution_leases(expires_at);
    `);
  })();
}

function rebuildServiceHandoffsWithForeignKeys(database: Database): void {
  if (
    !tableHasColumn(database, 'service_handoffs', 'turn_attempt_no') ||
    (tableHasForeignKey(database, {
      tableName: 'service_handoffs',
      referencedTable: 'paired_turn_attempts',
      fromColumns: ['turn_id', 'turn_attempt_no'],
      toColumns: ['turn_id', 'attempt_no'],
      onDelete: 'CASCADE',
    }) &&
      tableHasColumn(database, 'service_handoffs', 'turn_attempt_id') &&
      tableHasForeignKey(database, {
        tableName: 'service_handoffs',
        referencedTable: 'paired_turn_attempts',
        fromColumns: ['turn_attempt_id'],
        toColumns: ['attempt_id'],
        onDelete: 'CASCADE',
      }))
  ) {
    return;
  }

  database.transaction(() => {
    database.exec(`
      CREATE TABLE service_handoffs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        source_service_id TEXT NOT NULL,
        target_service_id TEXT NOT NULL,
        paired_task_id TEXT,
        paired_task_updated_at TEXT,
        turn_id TEXT,
        turn_attempt_id TEXT,
        turn_attempt_no INTEGER,
        turn_intent_kind TEXT,
        turn_role TEXT,
        source_role TEXT,
        source_agent_type TEXT,
        target_role TEXT,
        target_agent_type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        start_seq INTEGER,
        end_seq INTEGER,
        reason TEXT,
        intended_role TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        claimed_at TEXT,
        completed_at TEXT,
        last_error TEXT,
        FOREIGN KEY (turn_attempt_id)
          REFERENCES paired_turn_attempts(attempt_id)
          ON DELETE CASCADE,
        FOREIGN KEY (turn_id, turn_attempt_no)
          REFERENCES paired_turn_attempts(turn_id, attempt_no)
          ON DELETE CASCADE,
        CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
        CHECK (intended_role IN ('owner', 'reviewer', 'arbiter') OR intended_role IS NULL),
        CHECK (
          turn_intent_kind IN (
            'owner-turn',
            'reviewer-turn',
            'arbiter-turn',
            'owner-follow-up',
            'finalize-owner-turn'
          ) OR turn_intent_kind IS NULL
        ),
        CHECK (turn_role IN ('owner', 'reviewer', 'arbiter') OR turn_role IS NULL),
        CHECK (source_role IN ('owner', 'reviewer', 'arbiter') OR source_role IS NULL),
        CHECK (target_role IN ('owner', 'reviewer', 'arbiter') OR target_role IS NULL)
      );
      INSERT INTO service_handoffs_new (
        id,
        chat_jid,
        group_folder,
        source_service_id,
        target_service_id,
        paired_task_id,
        paired_task_updated_at,
        turn_id,
        turn_attempt_id,
        turn_attempt_no,
        turn_intent_kind,
        turn_role,
        source_role,
        source_agent_type,
        target_role,
        target_agent_type,
        prompt,
        status,
        start_seq,
        end_seq,
        reason,
        intended_role,
        created_at,
        claimed_at,
        completed_at,
        last_error
      )
      SELECT
        id,
        chat_jid,
        group_folder,
        source_service_id,
        target_service_id,
        paired_task_id,
        paired_task_updated_at,
        turn_id,
        COALESCE(
          turn_attempt_id,
          CASE
            WHEN turn_attempt_no IS NOT NULL
            THEN ${buildPairedTurnAttemptIdSql('turn_id', 'turn_attempt_no')}
            ELSE NULL
          END
        ),
        turn_attempt_no,
        turn_intent_kind,
        turn_role,
        source_role,
        source_agent_type,
        target_role,
        target_agent_type,
        prompt,
        status,
        start_seq,
        end_seq,
        reason,
        intended_role,
        created_at,
        claimed_at,
        completed_at,
        last_error
      FROM service_handoffs;
      DROP TABLE service_handoffs;
      ALTER TABLE service_handoffs_new RENAME TO service_handoffs;
      CREATE INDEX IF NOT EXISTS idx_service_handoffs_target
        ON service_handoffs(status, target_role, target_agent_type, created_at);
    `);
  })();
}

export function rebuildPairedTurnAttemptForeignKeyTables(
  database: Database,
): void {
  rebuildPairedTurnAttemptsWithForeignKeys(database);
  rebuildPairedTurnReservationsWithForeignKeys(database);
  rebuildPairedTaskExecutionLeasesWithForeignKeys(database);
  rebuildServiceHandoffsWithForeignKeys(database);
}

export function dropPairedTurnAttemptProvenanceConstraints(
  database: Database,
): void {
  database.exec(`
    DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
    DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
    DROP TRIGGER IF EXISTS paired_turn_reservations_validate_attempt_insert;
    DROP TRIGGER IF EXISTS paired_turn_reservations_validate_attempt_update;
    DROP TRIGGER IF EXISTS paired_task_execution_leases_validate_attempt_insert;
    DROP TRIGGER IF EXISTS paired_task_execution_leases_validate_attempt_update;
    DROP TRIGGER IF EXISTS service_handoffs_validate_attempt_insert;
    DROP TRIGGER IF EXISTS service_handoffs_validate_attempt_update;
  `);
}

export function applyPairedTurnAttemptProvenanceConstraints(
  database: Database,
): void {
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS paired_turn_attempts_validate_insert
    BEFORE INSERT ON paired_turn_attempts
    BEGIN
      SELECT RAISE(ABORT, 'paired_turn_attempts attempt_id must match turn_id/attempt_no')
       WHERE NEW.attempt_id IS NULL
          OR NEW.attempt_id != ${buildPairedTurnAttemptIdSql('NEW.turn_id', 'NEW.attempt_no')};
      SELECT RAISE(ABORT, 'paired_turn_attempts attempt 1 cannot declare parent_attempt_id')
       WHERE NEW.attempt_no <= 1
         AND NEW.parent_attempt_id IS NOT NULL;
      SELECT RAISE(ABORT, 'paired_turn_attempts must preserve contiguous parent lineage')
       WHERE NEW.attempt_no > 1
         AND NOT EXISTS (
           SELECT 1
             FROM paired_turn_attempts previous_attempt
            WHERE previous_attempt.turn_id = NEW.turn_id
              AND previous_attempt.attempt_no = NEW.attempt_no - 1
         );
      SELECT RAISE(ABORT, 'paired_turn_attempts must keep parent_attempt_id lineage')
       WHERE NEW.attempt_no > 1
         AND (
           NEW.parent_attempt_id IS NULL
           OR NEW.parent_attempt_id != ${buildPairedTurnAttemptParentIdSql('NEW.turn_id', 'NEW.attempt_no')}
         );
      SELECT RAISE(ABORT, 'paired_turn_attempts parent_attempt_id must point to the previous attempt of the same turn')
       WHERE NEW.parent_attempt_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM paired_turn_attempts previous_attempt
            WHERE COALESCE(
                    previous_attempt.attempt_id,
                    ${buildPairedTurnAttemptIdSql(
                      'previous_attempt.turn_id',
                      'previous_attempt.attempt_no',
                    )}
                  ) = NEW.parent_attempt_id
              AND previous_attempt.turn_id = NEW.turn_id
              AND previous_attempt.attempt_no = NEW.attempt_no - 1
         );
      SELECT RAISE(ABORT, 'paired_turn_attempts attempt 1 cannot declare parent_handoff_id')
       WHERE NEW.attempt_no <= 1
         AND NEW.parent_handoff_id IS NOT NULL;
      SELECT RAISE(ABORT, 'paired_turn_attempts parent_handoff_id must reference the previous attempt handoff of the same turn')
       WHERE NEW.parent_handoff_id IS NOT NULL
         AND NOT ${buildPairedTurnAttemptParentHandoffMatchSql({
           parentHandoffIdExpr: 'NEW.parent_handoff_id',
           turnIdExpr: 'NEW.turn_id',
           parentAttemptIdExpr: 'NEW.parent_attempt_id',
           attemptNoExpr: 'NEW.attempt_no',
         })};
      SELECT RAISE(ABORT, 'paired_turn_attempts continuation_handoff_id must reference a handoff of the same attempt')
       WHERE NEW.continuation_handoff_id IS NOT NULL
         AND NOT ${buildPairedTurnAttemptContinuationHandoffMatchSql({
           continuationHandoffIdExpr: 'NEW.continuation_handoff_id',
           turnIdExpr: 'NEW.turn_id',
           attemptIdExpr: 'NEW.attempt_id',
           attemptNoExpr: 'NEW.attempt_no',
         })};
      SELECT RAISE(ABORT, 'paired_turn_attempts running attempts must declare active_run_id')
       WHERE NEW.state = 'running'
         AND (
           NEW.active_run_id IS NULL
           OR TRIM(NEW.active_run_id) = ''
         );
      SELECT RAISE(ABORT, 'paired_turn_attempts only running attempts may declare active_run_id')
       WHERE NEW.state != 'running'
         AND NEW.active_run_id IS NOT NULL;
      SELECT RAISE(ABORT, 'paired_turn_attempts must reference a matching paired_turns row')
       WHERE NOT EXISTS (
         SELECT 1
           FROM paired_turns
          WHERE paired_turns.turn_id = NEW.turn_id
            AND paired_turns.task_id = NEW.task_id
            AND paired_turns.task_updated_at = NEW.task_updated_at
            AND paired_turns.role = NEW.role
            AND paired_turns.intent_kind = NEW.intent_kind
       );
    END;
    CREATE TRIGGER IF NOT EXISTS paired_turn_attempts_validate_update
    BEFORE UPDATE OF attempt_id, parent_attempt_id, parent_handoff_id, continuation_handoff_id, turn_id, attempt_no, task_id, task_updated_at, role, intent_kind, state, executor_service_id, executor_agent_type, active_run_id
      ON paired_turn_attempts
    BEGIN
      SELECT RAISE(ABORT, 'paired_turn_attempts attempt_id must match turn_id/attempt_no')
       WHERE NEW.attempt_id IS NULL
          OR NEW.attempt_id != ${buildPairedTurnAttemptIdSql('NEW.turn_id', 'NEW.attempt_no')};
      SELECT RAISE(ABORT, 'paired_turn_attempts attempt 1 cannot declare parent_attempt_id')
       WHERE NEW.attempt_no <= 1
         AND NEW.parent_attempt_id IS NOT NULL;
      SELECT RAISE(ABORT, 'paired_turn_attempts must preserve contiguous parent lineage')
       WHERE NEW.attempt_no > 1
         AND NOT EXISTS (
           SELECT 1
             FROM paired_turn_attempts previous_attempt
            WHERE previous_attempt.turn_id = NEW.turn_id
              AND previous_attempt.attempt_no = NEW.attempt_no - 1
         );
      SELECT RAISE(ABORT, 'paired_turn_attempts must keep parent_attempt_id lineage')
       WHERE NEW.attempt_no > 1
         AND (
           NEW.parent_attempt_id IS NULL
           OR NEW.parent_attempt_id != ${buildPairedTurnAttemptParentIdSql('NEW.turn_id', 'NEW.attempt_no')}
         );
      SELECT RAISE(ABORT, 'paired_turn_attempts parent_attempt_id must point to the previous attempt of the same turn')
       WHERE NEW.parent_attempt_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM paired_turn_attempts previous_attempt
            WHERE COALESCE(
                    previous_attempt.attempt_id,
                    ${buildPairedTurnAttemptIdSql(
                      'previous_attempt.turn_id',
                      'previous_attempt.attempt_no',
                    )}
                  ) = NEW.parent_attempt_id
              AND previous_attempt.turn_id = NEW.turn_id
              AND previous_attempt.attempt_no = NEW.attempt_no - 1
         );
      SELECT RAISE(ABORT, 'paired_turn_attempts attempt 1 cannot declare parent_handoff_id')
       WHERE NEW.attempt_no <= 1
         AND NEW.parent_handoff_id IS NOT NULL;
      SELECT RAISE(ABORT, 'paired_turn_attempts parent_handoff_id must reference the previous attempt handoff of the same turn')
       WHERE NEW.parent_handoff_id IS NOT NULL
         AND NOT ${buildPairedTurnAttemptParentHandoffMatchSql({
           parentHandoffIdExpr: 'NEW.parent_handoff_id',
           turnIdExpr: 'NEW.turn_id',
           parentAttemptIdExpr: 'NEW.parent_attempt_id',
           attemptNoExpr: 'NEW.attempt_no',
         })};
      SELECT RAISE(ABORT, 'paired_turn_attempts continuation_handoff_id must reference a handoff of the same attempt')
       WHERE NEW.continuation_handoff_id IS NOT NULL
         AND NOT ${buildPairedTurnAttemptContinuationHandoffMatchSql({
           continuationHandoffIdExpr: 'NEW.continuation_handoff_id',
           turnIdExpr: 'NEW.turn_id',
           attemptIdExpr: 'NEW.attempt_id',
           attemptNoExpr: 'NEW.attempt_no',
         })};
      SELECT RAISE(ABORT, 'paired_turn_attempts running attempts must declare active_run_id')
       WHERE NEW.state = 'running'
         AND (
           NEW.active_run_id IS NULL
           OR TRIM(NEW.active_run_id) = ''
         );
      SELECT RAISE(ABORT, 'paired_turn_attempts only running attempts may declare active_run_id')
       WHERE NEW.state != 'running'
         AND NEW.active_run_id IS NOT NULL;
      SELECT RAISE(ABORT, 'paired_turn_attempts must reference a matching paired_turns row')
       WHERE NOT EXISTS (
         SELECT 1
           FROM paired_turns
          WHERE paired_turns.turn_id = NEW.turn_id
            AND paired_turns.task_id = NEW.task_id
            AND paired_turns.task_updated_at = NEW.task_updated_at
            AND paired_turns.role = NEW.role
            AND paired_turns.intent_kind = NEW.intent_kind
       );
    END;
  `);

  if (tableHasColumn(database, 'paired_turn_reservations', 'turn_attempt_no')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_paired_turn_reservations_turn_attempt
        ON paired_turn_reservations(turn_id, turn_attempt_no);
      CREATE INDEX IF NOT EXISTS idx_paired_turn_reservations_turn_attempt_id
        ON paired_turn_reservations(turn_attempt_id);
      CREATE TRIGGER IF NOT EXISTS paired_turn_reservations_validate_attempt_insert
      BEFORE INSERT ON paired_turn_reservations
      BEGIN
        SELECT RAISE(ABORT, 'paired_turn_reservations.turn_attempt_no requires turn_id')
         WHERE NEW.turn_attempt_no IS NOT NULL
           AND NEW.turn_id IS NULL;
        SELECT RAISE(ABORT, 'paired_turn_reservations.turn_attempt provenance must keep attempt_id and attempt_no in sync')
         WHERE (NEW.turn_attempt_id IS NULL) != (NEW.turn_attempt_no IS NULL);
        SELECT RAISE(ABORT, 'paired_turn_reservations turn_attempt_no must reference a matching paired_turn_attempts row')
         WHERE NEW.turn_attempt_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM paired_turn_attempts
              WHERE paired_turn_attempts.attempt_id = NEW.turn_attempt_id
                AND paired_turn_attempts.turn_id = NEW.turn_id
                AND paired_turn_attempts.attempt_no = NEW.turn_attempt_no
                AND paired_turn_attempts.task_id = NEW.task_id
                AND paired_turn_attempts.task_updated_at = NEW.task_updated_at
                AND paired_turn_attempts.role = NEW.turn_role
                AND paired_turn_attempts.intent_kind = NEW.intent_kind
           );
      END;
      CREATE TRIGGER IF NOT EXISTS paired_turn_reservations_validate_attempt_update
      BEFORE UPDATE OF turn_id, turn_attempt_id, turn_attempt_no, task_id, task_updated_at, turn_role, intent_kind
        ON paired_turn_reservations
      BEGIN
        SELECT RAISE(ABORT, 'paired_turn_reservations.turn_attempt_no requires turn_id')
         WHERE NEW.turn_attempt_no IS NOT NULL
           AND NEW.turn_id IS NULL;
        SELECT RAISE(ABORT, 'paired_turn_reservations.turn_attempt provenance must keep attempt_id and attempt_no in sync')
         WHERE (NEW.turn_attempt_id IS NULL) != (NEW.turn_attempt_no IS NULL);
        SELECT RAISE(ABORT, 'paired_turn_reservations turn_attempt_no must reference a matching paired_turn_attempts row')
         WHERE NEW.turn_attempt_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM paired_turn_attempts
              WHERE paired_turn_attempts.attempt_id = NEW.turn_attempt_id
                AND paired_turn_attempts.turn_id = NEW.turn_id
                AND paired_turn_attempts.attempt_no = NEW.turn_attempt_no
                AND paired_turn_attempts.task_id = NEW.task_id
                AND paired_turn_attempts.task_updated_at = NEW.task_updated_at
                AND paired_turn_attempts.role = NEW.turn_role
                AND paired_turn_attempts.intent_kind = NEW.intent_kind
           );
      END;
    `);
  }

  if (
    tableHasColumn(database, 'paired_task_execution_leases', 'turn_attempt_no')
  ) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_paired_task_execution_leases_turn_attempt
        ON paired_task_execution_leases(turn_id, turn_attempt_no);
      CREATE INDEX IF NOT EXISTS idx_paired_task_execution_leases_turn_attempt_id
        ON paired_task_execution_leases(turn_attempt_id);
      CREATE TRIGGER IF NOT EXISTS paired_task_execution_leases_validate_attempt_insert
      BEFORE INSERT ON paired_task_execution_leases
      BEGIN
        SELECT RAISE(ABORT, 'paired_task_execution_leases.turn_attempt_no requires turn_id')
         WHERE NEW.turn_attempt_no IS NOT NULL
           AND NEW.turn_id IS NULL;
        SELECT RAISE(ABORT, 'paired_task_execution_leases turn_attempt provenance must keep attempt_id and attempt_no in sync')
         WHERE (NEW.turn_attempt_id IS NULL) != (NEW.turn_attempt_no IS NULL);
        SELECT RAISE(ABORT, 'paired_task_execution_leases turn_attempt_no must reference a matching paired_turn_attempts row')
         WHERE NEW.turn_attempt_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM paired_turn_attempts
              WHERE paired_turn_attempts.attempt_id = NEW.turn_attempt_id
                AND paired_turn_attempts.turn_id = NEW.turn_id
                AND paired_turn_attempts.attempt_no = NEW.turn_attempt_no
                AND paired_turn_attempts.task_id = NEW.task_id
                AND paired_turn_attempts.task_updated_at = NEW.task_updated_at
                AND paired_turn_attempts.role = NEW.role
                AND paired_turn_attempts.intent_kind = NEW.intent_kind
           );
      END;
      CREATE TRIGGER IF NOT EXISTS paired_task_execution_leases_validate_attempt_update
      BEFORE UPDATE OF turn_id, turn_attempt_id, turn_attempt_no, task_id, task_updated_at, role, intent_kind
        ON paired_task_execution_leases
      BEGIN
        SELECT RAISE(ABORT, 'paired_task_execution_leases.turn_attempt_no requires turn_id')
         WHERE NEW.turn_attempt_no IS NOT NULL
           AND NEW.turn_id IS NULL;
        SELECT RAISE(ABORT, 'paired_task_execution_leases turn_attempt provenance must keep attempt_id and attempt_no in sync')
         WHERE (NEW.turn_attempt_id IS NULL) != (NEW.turn_attempt_no IS NULL);
        SELECT RAISE(ABORT, 'paired_task_execution_leases turn_attempt_no must reference a matching paired_turn_attempts row')
         WHERE NEW.turn_attempt_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM paired_turn_attempts
              WHERE paired_turn_attempts.attempt_id = NEW.turn_attempt_id
                AND paired_turn_attempts.turn_id = NEW.turn_id
                AND paired_turn_attempts.attempt_no = NEW.turn_attempt_no
                AND paired_turn_attempts.task_id = NEW.task_id
                AND paired_turn_attempts.task_updated_at = NEW.task_updated_at
                AND paired_turn_attempts.role = NEW.role
                AND paired_turn_attempts.intent_kind = NEW.intent_kind
           );
      END;
    `);
  }

  if (
    tableHasColumn(database, 'service_handoffs', 'turn_attempt_no') &&
    tableHasColumn(database, 'service_handoffs', 'paired_task_id') &&
    tableHasColumn(database, 'service_handoffs', 'paired_task_updated_at') &&
    tableHasColumn(database, 'service_handoffs', 'turn_role') &&
    tableHasColumn(database, 'service_handoffs', 'turn_intent_kind')
  ) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_service_handoffs_turn_attempt
        ON service_handoffs(turn_id, turn_attempt_no);
      CREATE INDEX IF NOT EXISTS idx_service_handoffs_turn_attempt_id
        ON service_handoffs(turn_attempt_id);
      CREATE TRIGGER IF NOT EXISTS service_handoffs_validate_attempt_insert
      BEFORE INSERT ON service_handoffs
      BEGIN
        SELECT RAISE(ABORT, 'service_handoffs.turn_attempt_no requires paired turn identity')
         WHERE NEW.turn_attempt_no IS NOT NULL
           AND (
             NEW.turn_id IS NULL
             OR NEW.paired_task_id IS NULL
             OR NEW.paired_task_updated_at IS NULL
             OR NEW.turn_role IS NULL
             OR NEW.turn_intent_kind IS NULL
           );
        SELECT RAISE(ABORT, 'service_handoffs turn_attempt provenance must keep attempt_id and attempt_no in sync')
         WHERE (NEW.turn_attempt_id IS NULL) != (NEW.turn_attempt_no IS NULL);
        SELECT RAISE(ABORT, 'service_handoffs turn_attempt_no must reference a matching paired_turn_attempts row')
         WHERE NEW.turn_attempt_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM paired_turn_attempts
              WHERE paired_turn_attempts.attempt_id = NEW.turn_attempt_id
                AND paired_turn_attempts.turn_id = NEW.turn_id
                AND paired_turn_attempts.attempt_no = NEW.turn_attempt_no
                AND paired_turn_attempts.task_id = NEW.paired_task_id
                AND paired_turn_attempts.task_updated_at = NEW.paired_task_updated_at
                AND paired_turn_attempts.role = NEW.turn_role
                AND paired_turn_attempts.intent_kind = NEW.turn_intent_kind
           );
      END;
      CREATE TRIGGER IF NOT EXISTS service_handoffs_validate_attempt_update
      BEFORE UPDATE OF turn_id, turn_attempt_id, turn_attempt_no, paired_task_id, paired_task_updated_at, turn_role, turn_intent_kind
        ON service_handoffs
      BEGIN
        SELECT RAISE(ABORT, 'service_handoffs.turn_attempt_no requires paired turn identity')
         WHERE NEW.turn_attempt_no IS NOT NULL
           AND (
             NEW.turn_id IS NULL
             OR NEW.paired_task_id IS NULL
             OR NEW.paired_task_updated_at IS NULL
             OR NEW.turn_role IS NULL
             OR NEW.turn_intent_kind IS NULL
           );
        SELECT RAISE(ABORT, 'service_handoffs turn_attempt provenance must keep attempt_id and attempt_no in sync')
         WHERE (NEW.turn_attempt_id IS NULL) != (NEW.turn_attempt_no IS NULL);
        SELECT RAISE(ABORT, 'service_handoffs turn_attempt_no must reference a matching paired_turn_attempts row')
         WHERE NEW.turn_attempt_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
               FROM paired_turn_attempts
              WHERE paired_turn_attempts.attempt_id = NEW.turn_attempt_id
                AND paired_turn_attempts.turn_id = NEW.turn_id
                AND paired_turn_attempts.attempt_no = NEW.turn_attempt_no
                AND paired_turn_attempts.task_id = NEW.paired_task_id
                AND paired_turn_attempts.task_updated_at = NEW.paired_task_updated_at
                AND paired_turn_attempts.role = NEW.turn_role
                AND paired_turn_attempts.intent_kind = NEW.turn_intent_kind
           );
      END;
    `);
  }
}
