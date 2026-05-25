import type { Database } from 'bun:sqlite';

type SqlBinding = string | number | bigint | boolean | null | Uint8Array;

export const DB_EVIDENCE_ACTIONS = [
  'db_paired_task_status',
  'db_paired_task_flow',
  'db_recent_paired_failures',
] as const;

export type DbEvidenceAction = (typeof DB_EVIDENCE_ACTIONS)[number];

export interface DbEvidenceRequest {
  action: DbEvidenceAction;
  taskId?: string;
  minutes?: number;
  limit?: number;
}

export interface DbEvidenceScope {
  sourceGroup: string;
  isMain: boolean;
}

const DEFAULT_RECENT_MINUTES = 60;
const MAX_RECENT_MINUTES = 24 * 60;
const DEFAULT_ROW_LIMIT = 20;
const MAX_ROW_LIMIT = 100;
const TASK_ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,200}$/;

export function isDbEvidenceAction(value: unknown): value is DbEvidenceAction {
  return (
    typeof value === 'string' &&
    DB_EVIDENCE_ACTIONS.includes(value as DbEvidenceAction)
  );
}

export function normalizeDbEvidenceMinutes(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_RECENT_MINUTES;
  }
  const normalized = Math.trunc(value as number);
  return Math.min(Math.max(normalized, 1), MAX_RECENT_MINUTES);
}

export function normalizeDbEvidenceLimit(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_ROW_LIMIT;
  }
  const normalized = Math.trunc(value as number);
  return Math.min(Math.max(normalized, 1), MAX_ROW_LIMIT);
}

export function normalizeDbEvidenceTaskId(value?: string): string {
  const taskId = value?.trim();
  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`Unsupported paired task id for DB evidence: ${value}`);
  }
  return taskId;
}

function stringifyEvidence(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function groupScopeClause(scope: DbEvidenceScope): {
  clause: string;
  params: SqlBinding[];
} {
  return scope.isMain
    ? { clause: '', params: [] }
    : { clause: ' AND group_folder = ?', params: [scope.sourceGroup] };
}

function getScopedTask(
  database: Database,
  taskId: string,
  scope: DbEvidenceScope,
): Record<string, unknown> | null {
  const groupScope = groupScopeClause(scope);
  const row = database
    .prepare(
      `
          SELECT id,
                 group_folder,
                 chat_jid,
                 status,
                 round_trip_count,
                 owner_failure_count,
                 owner_step_done_streak,
                 finalize_step_done_count,
                 task_done_then_user_reopen_count,
                 empty_step_done_streak,
                 arbiter_verdict,
                 arbiter_requested_at,
                 completion_reason,
                 owner_agent_type,
                 reviewer_agent_type,
                 arbiter_agent_type,
                 created_at,
                 updated_at
            FROM paired_tasks
           WHERE id = ?
                 ${groupScope.clause}
        `,
    )
    .get(taskId, ...groupScope.params) as Record<string, unknown> | undefined;
  return row ?? null;
}

function runPairedTaskStatus(
  database: Database,
  request: DbEvidenceRequest,
  scope: DbEvidenceScope,
): string {
  const taskId = normalizeDbEvidenceTaskId(request.taskId);
  const task = getScopedTask(database, taskId, scope);
  return stringifyEvidence({
    action: request.action,
    task,
  });
}

function runPairedTaskFlow(
  database: Database,
  request: DbEvidenceRequest,
  scope: DbEvidenceScope,
): string {
  const taskId = normalizeDbEvidenceTaskId(request.taskId);
  const limit = normalizeDbEvidenceLimit(request.limit);
  const task = getScopedTask(database, taskId, scope);
  if (!task) {
    return stringifyEvidence({
      action: request.action,
      task: null,
      turns: [],
      attempts: [],
      outputs: [],
      deliveries: [],
    });
  }

  const turns = database
    .prepare(
      `
        SELECT turn_id,
               role,
               intent_kind,
               created_at,
               updated_at
          FROM paired_turns
         WHERE task_id = ?
         ORDER BY updated_at, created_at, turn_id
         LIMIT ?
      `,
    )
    .all(taskId, limit);

  const attempts = database
    .prepare(
      `
        SELECT attempt_id,
               parent_attempt_id,
               turn_id,
               attempt_no,
               role,
               intent_kind,
               state,
               executor_agent_type,
               active_run_id,
               created_at,
               updated_at,
               completed_at,
               length(last_error) AS last_error_chars
          FROM paired_turn_attempts
         WHERE task_id = ?
         ORDER BY updated_at, attempt_no, attempt_id
         LIMIT ?
      `,
    )
    .all(taskId, limit);

  const outputs = database
    .prepare(
      `
        SELECT turn_number,
               role,
               verdict,
               created_at,
               length(output_text) AS output_chars
          FROM paired_turn_outputs
         WHERE task_id = ?
         ORDER BY turn_number, created_at, role
         LIMIT ?
      `,
    )
    .all(taskId, limit);

  const deliveries = database
    .prepare(
      `
        SELECT id,
               agent_type,
               delivery_role,
               status,
               delivery_attempts,
               created_at,
               updated_at,
               delivered_at,
               length(result_payload) AS result_payload_chars,
               length(last_error) AS last_error_chars
          FROM work_items
         WHERE chat_jid = ?
           AND created_at >= ?
           AND created_at <= datetime(?, '+1 minute')
         ORDER BY created_at, id
         LIMIT ?
      `,
    )
    .all(
      String(task.chat_jid),
      String(task.created_at),
      String(task.updated_at),
      limit,
    );

  return stringifyEvidence({
    action: request.action,
    task,
    turns,
    attempts,
    outputs,
    deliveries,
  });
}

function runRecentPairedFailures(
  database: Database,
  request: DbEvidenceRequest,
  scope: DbEvidenceScope,
): string {
  const minutes = normalizeDbEvidenceMinutes(request.minutes);
  const limit = normalizeDbEvidenceLimit(request.limit);
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
  const groupScope = groupScopeClause(scope);

  const tasks = database
    .prepare(
      `
        SELECT id,
               group_folder,
               chat_jid,
               status,
               owner_failure_count,
               arbiter_verdict,
               completion_reason,
               arbiter_requested_at,
               updated_at
          FROM paired_tasks
         WHERE updated_at >= ?
           AND (
             owner_failure_count > 0
             OR status = 'arbiter_requested'
             OR arbiter_verdict IS NOT NULL
             OR completion_reason IS NOT NULL
           )
           ${groupScope.clause}
         ORDER BY updated_at DESC
         LIMIT ?
      `,
    )
    .all(cutoff, ...groupScope.params, limit);

  const attempts = database
    .prepare(
      `
        SELECT attempts.task_id,
               attempts.turn_id,
               attempts.attempt_no,
               attempts.role,
               attempts.intent_kind,
               attempts.state,
               attempts.executor_agent_type,
               attempts.active_run_id,
               attempts.updated_at,
               attempts.completed_at,
               length(attempts.last_error) AS last_error_chars
          FROM paired_turn_attempts attempts
          JOIN paired_tasks tasks
            ON tasks.id = attempts.task_id
         WHERE attempts.updated_at >= ?
           AND (
             attempts.state = 'failed'
             OR attempts.last_error IS NOT NULL
           )
           ${scope.isMain ? '' : 'AND tasks.group_folder = ?'}
         ORDER BY attempts.updated_at DESC
         LIMIT ?
      `,
    )
    .all(cutoff, ...(scope.isMain ? [] : [scope.sourceGroup]), limit);

  const deliveryRetries = database
    .prepare(
      `
        SELECT id,
               chat_jid,
               agent_type,
               delivery_role,
               status,
               delivery_attempts,
               updated_at,
               length(last_error) AS last_error_chars
          FROM work_items
         WHERE updated_at >= ?
           AND status = 'delivery_retry'
           ${scope.isMain ? '' : 'AND group_folder = ?'}
         ORDER BY updated_at DESC
         LIMIT ?
      `,
    )
    .all(cutoff, ...(scope.isMain ? [] : [scope.sourceGroup]), limit);

  return stringifyEvidence({
    action: request.action,
    window_minutes: minutes,
    cutoff,
    tasks,
    attempts,
    delivery_retries: deliveryRetries,
  });
}

export function runDbEvidenceRequest(
  database: Database,
  request: DbEvidenceRequest,
  scope: DbEvidenceScope,
): string {
  switch (request.action) {
    case 'db_paired_task_status':
      return runPairedTaskStatus(database, request, scope);
    case 'db_paired_task_flow':
      return runPairedTaskFlow(database, request, scope);
    case 'db_recent_paired_failures':
      return runRecentPairedFailures(database, request, scope);
  }
}
