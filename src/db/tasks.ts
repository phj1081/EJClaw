import { Database } from 'bun:sqlite';

import { AgentType, ScheduledTask, TaskRunLog } from '../types.js';

export type CreateScheduledTaskInput = Omit<
  ScheduledTask,
  | 'last_run'
  | 'last_result'
  | 'agent_type'
  | 'ci_provider'
  | 'ci_metadata'
  | 'max_duration_ms'
  | 'status_message_id'
  | 'status_started_at'
> & {
  agent_type?: AgentType | null;
  ci_provider?: ScheduledTask['ci_provider'];
  ci_metadata?: string | null;
  max_duration_ms?: number | null;
  status_message_id?: string | null;
  status_started_at?: string | null;
};

export type ScheduledTaskUpdates = Partial<
  Pick<
    ScheduledTask,
    | 'prompt'
    | 'schedule_type'
    | 'schedule_value'
    | 'next_run'
    | 'status'
    | 'suspended_until'
    | 'ci_metadata'
  >
>;

export type ScheduledTaskStatusTrackingUpdates = Partial<
  Pick<ScheduledTask, 'status_message_id' | 'status_started_at'>
>;

export function createTaskInDatabase(
  database: Database,
  task: CreateScheduledTaskInput,
): void {
  database
    .prepare(
      `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, agent_type, ci_provider, ci_metadata, max_duration_ms, status_message_id, status_started_at, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      task.id,
      task.group_folder,
      task.chat_jid,
      task.agent_type || 'claude-code',
      task.ci_provider ?? null,
      task.ci_metadata ?? null,
      task.max_duration_ms ?? null,
      task.status_message_id || null,
      task.status_started_at || null,
      task.prompt,
      task.schedule_type,
      task.schedule_value,
      task.context_mode || 'isolated',
      task.next_run,
      task.status,
      task.created_at,
    );
}

export function getTaskByIdFromDatabase(
  database: Database,
  id: string,
): ScheduledTask | undefined {
  const row = database
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as ScheduledTask | null | undefined;
  return row ?? undefined;
}

export function findDuplicateCiWatcherInDatabase(
  database: Database,
  chatJid: string,
  ciProvider: string,
  ciMetadata: string,
): ScheduledTask | undefined {
  return database
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE chat_jid = ? AND ci_provider = ? AND ci_metadata = ?
         AND status IN ('active', 'paused')
       LIMIT 1`,
    )
    .get(chatJid, ciProvider, ciMetadata) as ScheduledTask | undefined;
}

export function getTasksForGroupFromDatabase(
  database: Database,
  groupFolder: string,
  agentType?: AgentType,
): ScheduledTask[] {
  if (agentType) {
    return database
      .prepare(
        'SELECT * FROM scheduled_tasks WHERE group_folder = ? AND agent_type = ? ORDER BY created_at DESC',
      )
      .all(groupFolder, agentType) as ScheduledTask[];
  }

  return database
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasksFromDatabase(
  database: Database,
  agentType?: AgentType,
): ScheduledTask[] {
  if (agentType) {
    return database
      .prepare(
        'SELECT * FROM scheduled_tasks WHERE agent_type = ? ORDER BY created_at DESC',
      )
      .all(agentType) as ScheduledTask[];
  }

  return database
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTaskInDatabase(
  database: Database,
  id: string,
  updates: ScheduledTaskUpdates,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.suspended_until !== undefined) {
    fields.push('suspended_until = ?');
    values.push(updates.suspended_until);
  }
  if (updates.ci_metadata !== undefined) {
    fields.push('ci_metadata = ?');
    values.push(updates.ci_metadata);
  }

  if (fields.length === 0) return;

  values.push(id);
  database
    .prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function updateTaskStatusTrackingInDatabase(
  database: Database,
  id: string,
  updates: ScheduledTaskStatusTrackingUpdates,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.status_message_id !== undefined) {
    fields.push('status_message_id = ?');
    values.push(updates.status_message_id);
  }
  if (updates.status_started_at !== undefined) {
    fields.push('status_started_at = ?');
    values.push(updates.status_started_at);
  }

  if (fields.length === 0) return;

  values.push(id);
  database
    .prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function hasActiveCiWatcherForChatInDatabase(
  database: Database,
  chatJid: string,
): boolean {
  const row = database
    .prepare(
      `SELECT 1 FROM scheduled_tasks
       WHERE chat_jid = ? AND status = 'active' AND prompt LIKE '[BACKGROUND CI WATCH]%'
       LIMIT 1`,
    )
    .get(chatJid);
  return !!row;
}

export function getDueTasksFromDatabase(database: Database): ScheduledTask[] {
  const now = new Date().toISOString();
  return database
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
      AND (suspended_until IS NULL OR suspended_until <= ?)
    ORDER BY next_run
  `,
    )
    .all(now, now) as ScheduledTask[];
}

export function updateTaskAfterRunInDatabase(
  database: Database,
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
    )
    .run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRunInDatabase(
  database: Database,
  log: TaskRunLog,
): void {
  database
    .prepare(
      `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      log.task_id,
      log.run_at,
      log.duration_ms,
      log.status,
      log.result,
      log.error,
    );
}

export function getRecentConsecutiveErrorsFromDatabase(
  database: Database,
  taskId: string,
  limit: number = 5,
): string[] {
  const rows = database
    .prepare(
      `SELECT status, error FROM task_run_logs
       WHERE task_id = ? ORDER BY run_at DESC LIMIT ?`,
    )
    .all(taskId, limit) as Array<{ status: string; error: string | null }>;

  const errors: string[] = [];
  for (const row of rows) {
    if (row.status !== 'error' || !row.error) break;
    errors.push(row.error);
  }
  return errors;
}
