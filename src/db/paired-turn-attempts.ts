import { Database } from 'bun:sqlite';

import { normalizeServiceId } from '../config.js';
import { CODEX_BAD_REQUEST_DETAIL_JSON } from '../codex-bad-request-signal.js';
import type { PairedTurnIdentity } from '../paired-turn-identity.js';
import { inferAgentTypeFromServiceShadow } from '../role-service-shadow.js';
import type { AgentType, PairedRoomRole } from '../types.js';

export type PairedTurnAttemptState =
  | 'running'
  | 'delegated'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PairedTurnAttemptRecord {
  attempt_id: string;
  parent_attempt_id: string | null;
  parent_handoff_id: number | null;
  continuation_handoff_id: number | null;
  turn_id: string;
  attempt_no: number;
  task_id: string;
  task_updated_at: string;
  role: PairedRoomRole;
  intent_kind: PairedTurnIdentity['intentKind'];
  state: PairedTurnAttemptState;
  executor_service_id: string | null;
  executor_agent_type: AgentType | null;
  active_run_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  last_error: string | null;
}

export interface OwnerCodexBadRequestFailureSummary {
  taskId: string;
  failures: number;
  firstFailureAt: string;
  latestFailureAt: string;
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

export function buildPairedTurnAttemptId(
  turnId: string,
  attemptNo: number,
): string {
  return `${turnId}:attempt:${attemptNo}`;
}

export function buildPairedTurnAttemptParentId(
  turnId: string,
  attemptNo: number,
): string | null {
  if (attemptNo <= 1) {
    return null;
  }
  return buildPairedTurnAttemptId(turnId, attemptNo - 1);
}

function getPairedTurnAttemptParentIdFromDatabase(
  database: Database,
  turnId: string,
  attemptNo: number,
): string | null {
  if (attemptNo <= 1) {
    return null;
  }
  const parentAttemptId = getPairedTurnAttemptIdFromDatabase(
    database,
    turnId,
    attemptNo - 1,
  );
  if (parentAttemptId === null) {
    throw new Error(
      `paired_turn_attempts(${turnId}, attempt=${attemptNo}) must preserve contiguous parent lineage`,
    );
  }
  return parentAttemptId;
}

function tableHasColumn(
  database: Database,
  tableName: string,
  columnName: string,
): boolean {
  const rows = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

export function syncPairedTurnAttemptInDatabase(
  database: Database,
  args: {
    turnIdentity: PairedTurnIdentity;
    attemptNo: number;
    state: PairedTurnAttemptState;
    executorServiceId?: string | null;
    executorAgentType?: AgentType | null;
    activeRunId?: string | null;
    parentHandoffId?: number | null;
    continuationHandoffId?: number | null;
    now?: string;
    error?: string | null;
  },
): void {
  if (args.attemptNo < 1) {
    return;
  }

  const now = args.now ?? new Date().toISOString();
  const terminal =
    args.state === 'completed' ||
    args.state === 'failed' ||
    args.state === 'cancelled';
  const { executorServiceId, executorAgentType } = resolveExecutorMetadata({
    executorServiceId: args.executorServiceId,
    executorAgentType: args.executorAgentType,
  });
  const activeRunId =
    args.state === 'running' ? (args.activeRunId ?? null) : null;

  database
    .prepare(
      `
        INSERT INTO paired_turn_attempts (
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id, attempt_no) DO UPDATE SET
          attempt_id = excluded.attempt_id,
          parent_attempt_id = excluded.parent_attempt_id,
          parent_handoff_id = CASE
            WHEN excluded.parent_handoff_id IS NOT NULL
            THEN excluded.parent_handoff_id
            ELSE paired_turn_attempts.parent_handoff_id
          END,
          continuation_handoff_id = CASE
            WHEN excluded.continuation_handoff_id IS NOT NULL
            THEN excluded.continuation_handoff_id
            ELSE paired_turn_attempts.continuation_handoff_id
          END,
          task_id = excluded.task_id,
          task_updated_at = excluded.task_updated_at,
          role = excluded.role,
          intent_kind = excluded.intent_kind,
          state = excluded.state,
          executor_service_id = COALESCE(
            excluded.executor_service_id,
            paired_turn_attempts.executor_service_id
          ),
          executor_agent_type = COALESCE(
            excluded.executor_agent_type,
            paired_turn_attempts.executor_agent_type
          ),
          active_run_id = CASE
            WHEN excluded.state = 'running'
            THEN excluded.active_run_id
            ELSE NULL
          END,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          last_error = excluded.last_error
      `,
    )
    .run(
      buildPairedTurnAttemptId(args.turnIdentity.turnId, args.attemptNo),
      getPairedTurnAttemptParentIdFromDatabase(
        database,
        args.turnIdentity.turnId,
        args.attemptNo,
      ),
      args.parentHandoffId ?? null,
      args.continuationHandoffId ?? null,
      args.turnIdentity.turnId,
      args.attemptNo,
      args.turnIdentity.taskId,
      args.turnIdentity.taskUpdatedAt,
      args.turnIdentity.role,
      args.turnIdentity.intentKind,
      args.state,
      executorServiceId,
      executorAgentType,
      activeRunId,
      now,
      now,
      terminal ? now : null,
      args.error ?? null,
    );
}

export function backfillPairedTurnAttemptsFromTurns(database: Database): void {
  if (
    !tableHasColumn(database, 'paired_turns', 'state') ||
    !tableHasColumn(database, 'paired_turns', 'attempt_no')
  ) {
    return;
  }

  const rows = database
    .prepare(
      `
        SELECT *
          FROM paired_turns
         WHERE attempt_no >= 1
           AND state IN ('running', 'delegated', 'completed', 'failed', 'cancelled')
           AND NOT EXISTS (
             SELECT 1
               FROM paired_turn_attempts existing_attempt
              WHERE existing_attempt.turn_id = paired_turns.turn_id
                AND existing_attempt.attempt_no = paired_turns.attempt_no
           )
      `,
    )
    .all() as Array<{
    attempt_id: string | null;
    parent_attempt_id: string | null;
    turn_id: string;
    task_id: string;
    task_updated_at: string;
    role: PairedRoomRole;
    intent_kind: PairedTurnIdentity['intentKind'];
    state: PairedTurnAttemptState;
    executor_service_id: string | null;
    executor_agent_type: AgentType | null;
    active_run_id: string | null;
    attempt_no: number;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
    last_error: string | null;
  }>;

  if (rows.length === 0) {
    return;
  }

  const insert = database.prepare(
    `
        INSERT INTO paired_turn_attempts (
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(turn_id, attempt_no) DO NOTHING
    `,
  );

  const tx = database.transaction(
    (
      attemptRows: Array<{
        attempt_id?: string | null;
        parent_attempt_id?: string | null;
        continuation_handoff_id?: number | null;
        turn_id: string;
        task_id: string;
        task_updated_at: string;
        role: PairedRoomRole;
        intent_kind: PairedTurnIdentity['intentKind'];
        state: PairedTurnAttemptState;
        executor_service_id: string | null;
        executor_agent_type: AgentType | null;
        active_run_id: string | null;
        attempt_no: number;
        created_at: string;
        updated_at: string;
        completed_at: string | null;
        last_error: string | null;
      }>,
    ) => {
      for (const row of attemptRows) {
        const { executorServiceId, executorAgentType } =
          resolveExecutorMetadata({
            executorServiceId: row.executor_service_id,
            executorAgentType: row.executor_agent_type,
          });
        insert.run(
          row.attempt_id ??
            buildPairedTurnAttemptId(row.turn_id, row.attempt_no),
          row.parent_attempt_id ??
            getPairedTurnAttemptParentIdFromDatabase(
              database,
              row.turn_id,
              row.attempt_no,
            ),
          null,
          row.continuation_handoff_id ?? null,
          row.turn_id,
          row.attempt_no,
          row.task_id,
          row.task_updated_at,
          row.role,
          row.intent_kind,
          row.state,
          executorServiceId,
          executorAgentType,
          row.state === 'running' ? (row.active_run_id ?? null) : null,
          row.created_at,
          row.updated_at,
          row.completed_at,
          row.last_error,
        );
      }
    },
  );

  tx(rows);
}

export function getPairedTurnAttemptsForTurnFromDatabase(
  database: Database,
  turnId: string,
): PairedTurnAttemptRecord[] {
  return database
    .prepare(
      `
        SELECT *
          FROM paired_turn_attempts
         WHERE turn_id = ?
         ORDER BY attempt_no ASC
      `,
    )
    .all(turnId) as PairedTurnAttemptRecord[];
}

export function getCurrentPairedTurnAttemptForTurnFromDatabase(
  database: Database,
  turnId: string,
): PairedTurnAttemptRecord | undefined {
  return database
    .prepare(
      `
        SELECT *
          FROM paired_turn_attempts
         WHERE turn_id = ?
         ORDER BY attempt_no DESC
         LIMIT 1
      `,
    )
    .get(turnId) as PairedTurnAttemptRecord | undefined;
}

export function getPairedTurnAttemptByNumberFromDatabase(
  database: Database,
  turnId: string,
  attemptNo: number,
): PairedTurnAttemptRecord | undefined {
  return database
    .prepare(
      `
        SELECT *
          FROM paired_turn_attempts
         WHERE turn_id = ?
           AND attempt_no = ?
      `,
    )
    .get(turnId, attemptNo) as PairedTurnAttemptRecord | undefined;
}

export function getPairedTurnAttemptIdFromDatabase(
  database: Database,
  turnId: string,
  attemptNo: number,
): string | null {
  const row = database
    .prepare(
      `
        SELECT COALESCE(attempt_id, ? || ':attempt:' || CAST(? AS TEXT)) AS attempt_id
          FROM paired_turn_attempts
         WHERE turn_id = ?
           AND attempt_no = ?
      `,
    )
    .get(turnId, attemptNo, turnId, attemptNo) as
    | { attempt_id: string }
    | undefined;
  return row?.attempt_id ?? null;
}

export function getOwnerCodexBadRequestFailureSummaryForTaskFromDatabase(
  database: Database,
  args: {
    taskId: string;
    threshold: number;
  },
): OwnerCodexBadRequestFailureSummary | null {
  const threshold = Math.max(1, Math.floor(args.threshold));
  const attempts = database
    .prepare(
      `
        SELECT state, last_error, created_at
          FROM paired_turn_attempts
         WHERE task_id = ?
           AND role = 'owner'
           AND executor_agent_type = 'codex'
         ORDER BY created_at DESC, attempt_no DESC
      `,
    )
    .all(args.taskId) as Array<{
    state: PairedTurnAttemptState;
    last_error: string | null;
    created_at: string;
  }>;

  const consecutiveFailures = [];
  for (const attempt of attempts) {
    if (
      attempt.state === 'failed' &&
      attempt.last_error?.trim() === CODEX_BAD_REQUEST_DETAIL_JSON
    ) {
      consecutiveFailures.push(attempt);
      continue;
    }
    break;
  }

  if (consecutiveFailures.length < threshold) {
    return null;
  }

  const firstFailureAt =
    consecutiveFailures[consecutiveFailures.length - 1].created_at;
  const latestFailureAt = consecutiveFailures[0].created_at;

  return {
    taskId: args.taskId,
    failures: consecutiveFailures.length,
    firstFailureAt,
    latestFailureAt,
  };
}

export function setPairedTurnAttemptContinuationHandoffIdInDatabase(
  database: Database,
  args: {
    turnId: string;
    attemptNo: number;
    handoffId: number | null;
  },
): void {
  if (args.attemptNo < 1) {
    return;
  }
  database
    .prepare(
      `
        UPDATE paired_turn_attempts
           SET continuation_handoff_id = ?
         WHERE turn_id = ?
           AND attempt_no = ?
      `,
    )
    .run(args.handoffId, args.turnId, args.attemptNo);
}

export function clearPairedTurnAttemptsInDatabase(database: Database): void {
  database.prepare('DELETE FROM paired_turn_attempts').run();
}
