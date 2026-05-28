import type { Database } from 'bun:sqlite';

import { parseGitHubCiMetadata } from './github-ci.js';
import { extractWatchCiTarget } from './task-watch-status.js';

type SqlBinding = string | number | bigint | boolean | null | Uint8Array;

export const DB_EVIDENCE_ACTIONS = [
  'db_paired_task_status',
  'db_paired_task_flow',
  'db_recent_paired_failures',
  'db_recent_scheduled_tasks',
  'db_scheduled_task_runs',
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

function normalizeScheduledTaskEvidenceRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const prompt = typeof row.prompt === 'string' ? row.prompt : '';
  const metadata = parseGitHubCiMetadata(
    typeof row.ci_metadata === 'string' ? row.ci_metadata : null,
  );

  return {
    id: row.id,
    group_folder: row.group_folder,
    chat_jid: row.chat_jid,
    agent_type: row.agent_type,
    room_role: row.room_role,
    ci_provider: row.ci_provider,
    ci_repo: metadata?.repo ?? null,
    ci_run_id: metadata?.run_id ?? null,
    ci_poll_count: metadata?.poll_count ?? null,
    ci_consecutive_errors: metadata?.consecutive_errors ?? null,
    ci_last_checked_at: metadata?.last_checked_at ?? null,
    ci_target: extractWatchCiTarget(prompt),
    max_duration_ms: row.max_duration_ms,
    status_message_id: row.status_message_id,
    status_started_at: row.status_started_at,
    schedule_type: row.schedule_type,
    schedule_value: row.schedule_value,
    next_run: row.next_run,
    last_run: row.last_run,
    last_result_chars: row.last_result_chars,
    status: row.status,
    created_at: row.created_at,
    prompt_chars: row.prompt_chars,
  };
}

function runRecentScheduledTasks(
  database: Database,
  request: DbEvidenceRequest,
  scope: DbEvidenceScope,
): string {
  const minutes = normalizeDbEvidenceMinutes(request.minutes);
  const limit = normalizeDbEvidenceLimit(request.limit);
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
  const groupScope = groupScopeClause(scope);

  const rows = database
    .prepare(
      `
        SELECT id,
               group_folder,
               chat_jid,
               agent_type,
               room_role,
               ci_provider,
               ci_metadata,
               max_duration_ms,
               status_message_id,
               status_started_at,
               prompt,
               length(prompt) AS prompt_chars,
               schedule_type,
               schedule_value,
               next_run,
               last_run,
               length(last_result) AS last_result_chars,
               status,
               created_at
          FROM scheduled_tasks
         WHERE (
             created_at >= ?
             OR last_run >= ?
             OR next_run >= ?
             OR status_started_at >= ?
             OR status IN ('active', 'paused')
           )
           ${groupScope.clause}
         ORDER BY COALESCE(last_run, status_started_at, next_run, created_at) DESC
         LIMIT ?
      `,
    )
    .all(cutoff, cutoff, cutoff, cutoff, ...groupScope.params, limit) as Array<
    Record<string, unknown>
  >;

  return stringifyEvidence({
    action: request.action,
    window_minutes: minutes,
    cutoff,
    tasks: rows.map(normalizeScheduledTaskEvidenceRow),
  });
}

function runScheduledTaskRuns(
  database: Database,
  request: DbEvidenceRequest,
  scope: DbEvidenceScope,
): string {
  const minutes = normalizeDbEvidenceMinutes(request.minutes);
  const limit = normalizeDbEvidenceLimit(request.limit);
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
  const taskId = request.taskId
    ? normalizeDbEvidenceTaskId(request.taskId)
    : null;
  const params: SqlBinding[] = [cutoff];
  const clauses = ['logs.run_at >= ?'];

  if (taskId) {
    clauses.push('logs.task_id = ?');
    params.push(taskId);
  }
  if (!scope.isMain) {
    clauses.push('tasks.group_folder = ?');
    params.push(scope.sourceGroup);
  }
  params.push(limit);

  const rows = database
    .prepare(
      `
        SELECT logs.task_id,
               tasks.group_folder,
               tasks.chat_jid,
               tasks.agent_type,
               tasks.room_role,
               tasks.ci_provider,
               logs.run_at,
               logs.duration_ms,
               logs.status,
               length(logs.result) AS result_chars,
               length(logs.error) AS error_chars
          FROM task_run_logs logs
          LEFT JOIN scheduled_tasks tasks
            ON tasks.id = logs.task_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY logs.run_at DESC, logs.id DESC
         LIMIT ?
      `,
    )
    .all(...params);

  return stringifyEvidence({
    action: request.action,
    window_minutes: minutes,
    cutoff,
    task_id: taskId,
    runs: rows,
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
    case 'db_recent_scheduled_tasks':
      return runRecentScheduledTasks(database, request, scope);
    case 'db_scheduled_task_runs':
      return runScheduledTaskRuns(database, request, scope);
  }
}
