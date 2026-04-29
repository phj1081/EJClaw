import { Database } from 'bun:sqlite';

import { normalizeServiceId } from '../config.js';
import type { PairedTurnIdentity } from '../paired-turn-identity.js';
import { inferAgentTypeFromServiceShadow } from '../role-service-shadow.js';
import type { AgentType, PairedRoomRole } from '../types.js';
import {
  getPairedTurnAttemptByNumberFromDatabase,
  getCurrentPairedTurnAttemptForTurnFromDatabase,
  type PairedTurnAttemptRecord,
  syncPairedTurnAttemptInDatabase,
} from './paired-turn-attempts.js';

export type PairedTurnState =
  | 'queued'
  | 'running'
  | 'delegated'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PairedTurnRecord {
  turn_id: string;
  task_id: string;
  task_updated_at: string;
  role: PairedRoomRole;
  intent_kind: PairedTurnIdentity['intentKind'];
  state: PairedTurnState;
  executor_service_id: string | null;
  executor_agent_type: AgentType | null;
  attempt_no: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  last_error: string | null;
  progress_text?: string | null;
  progress_updated_at?: string | null;
}

interface StoredPairedTurnRow {
  turn_id: string;
  task_id: string;
  task_updated_at: string;
  role: PairedRoomRole;
  intent_kind: PairedTurnIdentity['intentKind'];
  created_at: string;
  updated_at: string;
  progress_text?: string | null;
  progress_updated_at?: string | null;
}

function hydratePairedTurnRecord(
  row: StoredPairedTurnRow,
  currentAttemptRow?: PairedTurnAttemptRecord,
): PairedTurnRecord {
  if (!currentAttemptRow) {
    return {
      ...row,
      state: 'queued',
      executor_service_id: null,
      executor_agent_type: null,
      attempt_no: 0,
      completed_at: null,
      last_error: null,
    };
  }

  return {
    ...row,
    task_id: currentAttemptRow.task_id,
    task_updated_at: currentAttemptRow.task_updated_at,
    role: currentAttemptRow.role,
    intent_kind: currentAttemptRow.intent_kind,
    state: currentAttemptRow.state,
    executor_service_id: currentAttemptRow.executor_service_id,
    executor_agent_type: currentAttemptRow.executor_agent_type,
    attempt_no: currentAttemptRow.attempt_no,
    updated_at: currentAttemptRow.updated_at,
    completed_at: currentAttemptRow.completed_at,
    last_error: currentAttemptRow.last_error,
  };
}

function resolveExecutorMetadata(args: {
  executorServiceId?: string | null;
  executorAgentType?: AgentType | null;
}): {
  executorServiceId: string | null;
  executorAgentType: AgentType | null;
} {
  const executorServiceId = args.executorServiceId
    ? normalizeServiceId(args.executorServiceId)
    : null;
  const executorAgentType =
    args.executorAgentType ??
    inferAgentTypeFromServiceShadow(executorServiceId) ??
    null;
  return {
    executorServiceId,
    executorAgentType,
  };
}

function getRequiredPairedTurnAttemptByNumber(
  database: Database,
  turnIdentity: PairedTurnIdentity,
  attemptNo: number,
): PairedTurnAttemptRecord {
  const currentAttemptRow = getPairedTurnAttemptByNumberFromDatabase(
    database,
    turnIdentity.turnId,
    attemptNo,
  );
  if (!currentAttemptRow) {
    throw new Error(
      `paired_turns(${turnIdentity.turnId}) did not materialize attempt ${attemptNo}`,
    );
  }
  return currentAttemptRow;
}

export function ensurePairedTurnQueuedInDatabase(
  database: Database,
  turnIdentity: PairedTurnIdentity,
): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `
        INSERT INTO paired_turns (
          turn_id,
          task_id,
          task_updated_at,
          role,
          intent_kind,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          task_id = excluded.task_id,
          task_updated_at = excluded.task_updated_at,
          role = excluded.role,
          intent_kind = excluded.intent_kind,
          updated_at = excluded.updated_at,
          created_at = paired_turns.created_at
      `,
    )
    .run(
      turnIdentity.turnId,
      turnIdentity.taskId,
      turnIdentity.taskUpdatedAt,
      turnIdentity.role,
      turnIdentity.intentKind,
      now,
      now,
    );
}

export function markPairedTurnRunningInDatabase(
  database: Database,
  args: {
    turnIdentity: PairedTurnIdentity;
    executorServiceId?: string | null;
    executorAgentType?: AgentType | null;
    runId?: string | null;
  },
): PairedTurnAttemptRecord | undefined {
  const now = new Date().toISOString();
  const { executorServiceId, executorAgentType } = resolveExecutorMetadata({
    executorServiceId: args.executorServiceId,
    executorAgentType: args.executorAgentType,
  });
  const runId = args.runId ?? null;
  return database.transaction(() => {
    const previousTurnRow = getPairedTurnByIdFromDatabase(
      database,
      args.turnIdentity.turnId,
    );
    const previousAttemptRow = previousTurnRow
      ? getCurrentPairedTurnAttemptForTurnFromDatabase(
          database,
          args.turnIdentity.turnId,
        )
      : undefined;
    const previousAttemptNo = previousAttemptRow?.attempt_no ?? 0;
    const previousAttemptActiveRunId =
      previousAttemptRow?.active_run_id ?? null;
    const isSameRunContinuation =
      previousAttemptRow?.state === 'running' &&
      previousAttemptActiveRunId !== null &&
      runId !== null &&
      previousAttemptActiveRunId === runId;
    const isDelegatedContinuation =
      previousAttemptRow?.state === 'delegated' &&
      (previousAttemptRow.executor_service_id ?? '') ===
        (executorServiceId ?? '') &&
      (previousAttemptRow.executor_agent_type ?? '') ===
        (executorAgentType ?? '');
    const nextAttemptNo = previousAttemptRow
      ? isSameRunContinuation || isDelegatedContinuation
        ? Math.max(previousAttemptNo, 1)
        : Math.max(previousAttemptNo, 0) + 1
      : 1;
    const nextAttemptParentHandoffId =
      previousAttemptRow && !isSameRunContinuation && !isDelegatedContinuation
        ? previousAttemptRow.continuation_handoff_id
        : null;

    if (
      previousTurnRow &&
      previousTurnRow.attempt_no >= 1 &&
      !previousAttemptRow
    ) {
      throw new Error(
        `paired_turns(${args.turnIdentity.turnId}) cannot derive retry lineage because attempt ${previousTurnRow.attempt_no} is missing`,
      );
    }

    database
      .prepare(
        `
          INSERT INTO paired_turns (
            turn_id,
            task_id,
            task_updated_at,
            role,
            intent_kind,
            created_at,
            updated_at
          )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          task_id = excluded.task_id,
          task_updated_at = excluded.task_updated_at,
          role = excluded.role,
          intent_kind = excluded.intent_kind,
          updated_at = excluded.updated_at,
          created_at = paired_turns.created_at
        `,
      )
      .run(
        args.turnIdentity.turnId,
        args.turnIdentity.taskId,
        args.turnIdentity.taskUpdatedAt,
        args.turnIdentity.role,
        args.turnIdentity.intentKind,
        now,
        now,
      );

    if (
      previousAttemptRow?.state === 'running' &&
      previousAttemptNo >= 1 &&
      previousAttemptActiveRunId &&
      runId &&
      previousAttemptActiveRunId !== runId
    ) {
      syncPairedTurnAttemptInDatabase(database, {
        turnIdentity: args.turnIdentity,
        attemptNo: previousAttemptNo,
        state: 'cancelled',
        executorServiceId: previousAttemptRow.executor_service_id,
        executorAgentType: previousAttemptRow.executor_agent_type,
        now,
      });
    }

    syncPairedTurnAttemptInDatabase(database, {
      turnIdentity: args.turnIdentity,
      attemptNo: nextAttemptNo,
      state: 'running',
      executorServiceId,
      executorAgentType,
      activeRunId: runId,
      parentHandoffId: nextAttemptParentHandoffId,
    });

    return getRequiredPairedTurnAttemptByNumber(
      database,
      args.turnIdentity,
      nextAttemptNo,
    );
  })();
}

export function markPairedTurnDelegatedInDatabase(
  database: Database,
  args: {
    turnIdentity: PairedTurnIdentity;
    executorServiceId?: string | null;
    executorAgentType?: AgentType | null;
  },
): PairedTurnAttemptRecord | undefined {
  const now = new Date().toISOString();
  const { executorServiceId, executorAgentType } = resolveExecutorMetadata({
    executorServiceId: args.executorServiceId,
    executorAgentType: args.executorAgentType,
  });
  return database.transaction(() => {
    const previousTurnRow = getPairedTurnByIdFromDatabase(
      database,
      args.turnIdentity.turnId,
    );
    const currentAttemptRow = previousTurnRow
      ? getCurrentPairedTurnAttemptForTurnFromDatabase(
          database,
          args.turnIdentity.turnId,
        )
      : undefined;
    if (
      previousTurnRow &&
      previousTurnRow.attempt_no >= 1 &&
      !currentAttemptRow
    ) {
      throw new Error(
        `paired_turns(${args.turnIdentity.turnId}) cannot mark delegated because attempt ${previousTurnRow.attempt_no} is missing`,
      );
    }
    const currentAttemptNo = Math.max(currentAttemptRow?.attempt_no ?? 1, 1);

    database
      .prepare(
        `
          INSERT INTO paired_turns (
            turn_id,
            task_id,
            task_updated_at,
            role,
            intent_kind,
            created_at,
            updated_at
          )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          task_id = excluded.task_id,
          task_updated_at = excluded.task_updated_at,
          role = excluded.role,
          intent_kind = excluded.intent_kind,
          updated_at = excluded.updated_at,
          created_at = paired_turns.created_at
        `,
      )
      .run(
        args.turnIdentity.turnId,
        args.turnIdentity.taskId,
        args.turnIdentity.taskUpdatedAt,
        args.turnIdentity.role,
        args.turnIdentity.intentKind,
        now,
        now,
      );

    syncPairedTurnAttemptInDatabase(database, {
      turnIdentity: args.turnIdentity,
      attemptNo: currentAttemptNo,
      state: 'delegated',
      executorServiceId,
      executorAgentType,
      now,
    });

    return getRequiredPairedTurnAttemptByNumber(
      database,
      args.turnIdentity,
      currentAttemptNo,
    );
  })();
}

function markPairedTurnTerminalStateInDatabase(
  database: Database,
  args: {
    turnIdentity: PairedTurnIdentity;
    state: 'completed' | 'failed' | 'cancelled';
    error?: string | null;
  },
): void {
  const now = new Date().toISOString();
  database.transaction(() => {
    const existingTurnRow = getPairedTurnByIdFromDatabase(
      database,
      args.turnIdentity.turnId,
    );
    const currentAttemptRow = existingTurnRow
      ? getCurrentPairedTurnAttemptForTurnFromDatabase(
          database,
          args.turnIdentity.turnId,
        )
      : undefined;
    if (
      existingTurnRow &&
      existingTurnRow.attempt_no >= 1 &&
      !currentAttemptRow
    ) {
      throw new Error(
        `paired_turns(${args.turnIdentity.turnId}) cannot mark ${args.state} because attempt ${existingTurnRow.attempt_no} is missing`,
      );
    }
    const currentAttemptNo = Math.max(currentAttemptRow?.attempt_no ?? 1, 1);

    database
      .prepare(
        `
          INSERT INTO paired_turns (
            turn_id,
            task_id,
            task_updated_at,
            role,
            intent_kind,
            created_at,
            updated_at
          )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          task_id = excluded.task_id,
          task_updated_at = excluded.task_updated_at,
          role = excluded.role,
          intent_kind = excluded.intent_kind,
          updated_at = excluded.updated_at,
          created_at = paired_turns.created_at
        `,
      )
      .run(
        args.turnIdentity.turnId,
        args.turnIdentity.taskId,
        args.turnIdentity.taskUpdatedAt,
        args.turnIdentity.role,
        args.turnIdentity.intentKind,
        now,
        now,
      );

    syncPairedTurnAttemptInDatabase(database, {
      turnIdentity: args.turnIdentity,
      attemptNo: currentAttemptNo,
      state: args.state,
      executorServiceId: currentAttemptRow?.executor_service_id,
      executorAgentType: currentAttemptRow?.executor_agent_type,
      now,
      error: args.error,
    });
  })();
}

export function completePairedTurnInDatabase(
  database: Database,
  turnIdentity: PairedTurnIdentity,
): void {
  markPairedTurnTerminalStateInDatabase(database, {
    turnIdentity,
    state: 'completed',
  });
}

export function failPairedTurnInDatabase(
  database: Database,
  args: {
    turnIdentity: PairedTurnIdentity;
    error?: string | null;
  },
): void {
  markPairedTurnTerminalStateInDatabase(database, {
    turnIdentity: args.turnIdentity,
    state: 'failed',
    error: args.error,
  });
}

export function cancelPairedTurnInDatabase(
  database: Database,
  args: {
    turnIdentity: PairedTurnIdentity;
    error?: string | null;
  },
): void {
  markPairedTurnTerminalStateInDatabase(database, {
    turnIdentity: args.turnIdentity,
    state: 'cancelled',
    error: args.error,
  });
}

export function getPairedTurnByIdFromDatabase(
  database: Database,
  turnId: string,
): PairedTurnRecord | undefined {
  const row = database
    .prepare('SELECT * FROM paired_turns WHERE turn_id = ?')
    .get(turnId) as StoredPairedTurnRow | undefined;
  if (!row) {
    return undefined;
  }
  return hydratePairedTurnRecord(
    row,
    getCurrentPairedTurnAttemptForTurnFromDatabase(database, turnId),
  );
}

const updateProgressTextStmtCache = new WeakMap<
  Database,
  ReturnType<Database['prepare']>
>();

export function updatePairedTurnProgressTextFromDatabase(
  database: Database,
  turnId: string,
  progressText: string | null,
): void {
  const now = new Date().toISOString();
  let stmt = updateProgressTextStmtCache.get(database);
  if (!stmt) {
    stmt = database.prepare(`
      UPDATE paired_turns
         SET progress_text = ?,
             progress_updated_at = ?,
             updated_at = ?
       WHERE turn_id = ?
    `);
    updateProgressTextStmtCache.set(database, stmt);
  }
  stmt.run(progressText, now, now, turnId);
}

const latestPairedTurnStmtCache = new WeakMap<
  Database,
  ReturnType<Database['prepare']>
>();

export function getLatestPairedTurnForTaskFromDatabase(
  database: Database,
  taskId: string,
): PairedTurnRecord | null {
  let stmt = latestPairedTurnStmtCache.get(database);
  if (!stmt) {
    stmt = database.prepare(`
      SELECT *
        FROM paired_turns
       WHERE task_id = ?
       ORDER BY CASE
                  WHEN progress_text IS NOT NULL
                   AND trim(progress_text) <> ''
                   AND progress_updated_at IS NOT NULL
                   AND progress_updated_at > updated_at
                  THEN progress_updated_at
                  ELSE updated_at
                END DESC,
                turn_id DESC
       LIMIT 1
    `);
    latestPairedTurnStmtCache.set(database, stmt);
  }
  const row = stmt.get(taskId) as StoredPairedTurnRow | undefined;
  if (!row) return null;
  return hydratePairedTurnRecord(
    row,
    getCurrentPairedTurnAttemptForTurnFromDatabase(database, row.turn_id),
  );
}

export function getPairedTurnsForTaskFromDatabase(
  database: Database,
  taskId: string,
): PairedTurnRecord[] {
  const rows = database
    .prepare(
      `
        SELECT *
          FROM paired_turns
         WHERE COALESCE(
                 (
                   SELECT paired_turn_attempts.task_id
                     FROM paired_turn_attempts
                    WHERE paired_turn_attempts.turn_id = paired_turns.turn_id
                    ORDER BY paired_turn_attempts.attempt_no DESC
                    LIMIT 1
                 ),
                 paired_turns.task_id
               ) = ?
         ORDER BY created_at ASC, turn_id ASC
      `,
    )
    .all(taskId) as StoredPairedTurnRow[];
  return rows.map((row) =>
    hydratePairedTurnRecord(
      row,
      getCurrentPairedTurnAttemptForTurnFromDatabase(database, row.turn_id),
    ),
  );
}

export function clearPairedTurnsInDatabase(database: Database): void {
  database.prepare('DELETE FROM paired_turns').run();
}
