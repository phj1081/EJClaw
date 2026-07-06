import { Database } from 'bun:sqlite';

import {
  fillCanonicalPairedTaskMetadata,
  readCanonicalPairedTaskMetadata,
} from './canonical-role-metadata.js';
import { PairedTask } from '../types.js';

interface StoredPairedTaskRow extends Omit<
  PairedTask,
  | 'owner_service_id'
  | 'reviewer_service_id'
  | 'owner_agent_type'
  | 'reviewer_agent_type'
  | 'arbiter_agent_type'
> {
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}

export type PairedTaskUpdates = Partial<
  Pick<
    PairedTask,
    | 'title'
    | 'source_ref'
    | 'plan_notes'
    | 'review_requested_at'
    | 'round_trip_count'
    | 'owner_failure_count'
    | 'owner_step_done_streak'
    | 'finalize_step_done_count'
    | 'task_done_then_user_reopen_count'
    | 'empty_step_done_streak'
    | 'status'
    | 'arbiter_verdict'
    | 'arbiter_requested_at'
    | 'completion_reason'
    | 'updated_at'
  >
>;

function hydratePairedTaskRow(
  database: Database,
  row: StoredPairedTaskRow,
): PairedTask {
  const {
    ownerAgentType,
    reviewerAgentType,
    arbiterAgentType,
    ownerServiceId,
    reviewerServiceId,
  } = readCanonicalPairedTaskMetadata({
    id: row.id,
    owner_service_id: row.owner_service_id,
    reviewer_service_id: row.reviewer_service_id,
    owner_agent_type: row.owner_agent_type,
    reviewer_agent_type: row.reviewer_agent_type,
    arbiter_agent_type: row.arbiter_agent_type,
  });

  return {
    ...row,
    owner_service_id: ownerServiceId,
    reviewer_service_id: reviewerServiceId,
    owner_agent_type: ownerAgentType,
    reviewer_agent_type: reviewerAgentType,
    arbiter_agent_type: arbiterAgentType,
  };
}

export function createPairedTaskInDatabase(
  database: Database,
  task: PairedTask,
): void {
  const {
    ownerAgentType,
    reviewerAgentType,
    arbiterAgentType,
    ownerServiceId,
    reviewerServiceId,
  } = fillCanonicalPairedTaskMetadata({
    id: task.id,
    owner_service_id: task.owner_service_id,
    reviewer_service_id: task.reviewer_service_id,
    owner_agent_type: task.owner_agent_type,
    reviewer_agent_type: task.reviewer_agent_type,
    arbiter_agent_type: task.arbiter_agent_type,
  });

  database
    .prepare(
      `
        INSERT INTO paired_tasks (
          id,
          chat_jid,
          group_folder,
          owner_service_id,
          reviewer_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type,
          title,
          source_ref,
          plan_notes,
          review_requested_at,
          round_trip_count,
          owner_failure_count,
          owner_step_done_streak,
          finalize_step_done_count,
          task_done_then_user_reopen_count,
          empty_step_done_streak,
          status,
          arbiter_verdict,
          arbiter_requested_at,
          completion_reason,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      task.id,
      task.chat_jid,
      task.group_folder,
      ownerServiceId,
      reviewerServiceId,
      ownerAgentType,
      reviewerAgentType,
      arbiterAgentType,
      task.title,
      task.source_ref,
      task.plan_notes,
      task.review_requested_at,
      task.round_trip_count,
      task.owner_failure_count ?? 0,
      task.owner_step_done_streak ?? 0,
      task.finalize_step_done_count ?? 0,
      task.task_done_then_user_reopen_count ?? 0,
      task.empty_step_done_streak ?? 0,
      task.status,
      task.arbiter_verdict,
      task.arbiter_requested_at,
      task.completion_reason,
      task.created_at,
      task.updated_at,
    );
}

export function getPairedTaskByIdFromDatabase(
  database: Database,
  id: string,
): PairedTask | undefined {
  const row = database
    .prepare('SELECT * FROM paired_tasks WHERE id = ?')
    .get(id) as StoredPairedTaskRow | undefined;
  return row ? hydratePairedTaskRow(database, row) : undefined;
}

const latestPairedTaskStmtCache = new WeakMap<
  Database,
  ReturnType<Database['prepare']>
>();

export function getLatestPairedTaskForChatFromDatabase(
  database: Database,
  chatJid: string,
): PairedTask | undefined {
  let stmt = latestPairedTaskStmtCache.get(database);
  if (!stmt) {
    stmt = database.prepare(`
      SELECT *
        FROM paired_tasks
       WHERE chat_jid = ?
       ORDER BY updated_at DESC
       LIMIT 1
    `);
    latestPairedTaskStmtCache.set(database, stmt);
  }
  const row = stmt.get(chatJid) as StoredPairedTaskRow | undefined;
  return row ? hydratePairedTaskRow(database, row) : undefined;
}

export function getLatestOpenPairedTaskForChatFromDatabase(
  database: Database,
  chatJid: string,
): PairedTask | undefined {
  const row = database
    .prepare(
      `
        SELECT *
          FROM paired_tasks
         WHERE chat_jid = ?
           AND status NOT IN ('completed')
         ORDER BY updated_at DESC
         LIMIT 1
      `,
    )
    .get(chatJid) as StoredPairedTaskRow | undefined;
  return row ? hydratePairedTaskRow(database, row) : undefined;
}

export function getAllOpenPairedTasksFromDatabase(
  database: Database,
): PairedTask[] {
  const rows = database
    .prepare(
      `
        SELECT *
          FROM paired_tasks
         WHERE status NOT IN ('completed')
         ORDER BY updated_at DESC, created_at DESC
      `,
    )
    .all() as StoredPairedTaskRow[];
  return rows.map((row) => hydratePairedTaskRow(database, row));
}

export function getLatestPreviousPairedTaskForChatFromDatabase(
  database: Database,
  chatJid: string,
  currentTaskId: string,
): PairedTask | undefined {
  const row = database
    .prepare(
      `
        SELECT *
          FROM paired_tasks
         WHERE chat_jid = ?
           AND id != ?
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1
      `,
    )
    .get(chatJid, currentTaskId) as StoredPairedTaskRow | undefined;
  return row ? hydratePairedTaskRow(database, row) : undefined;
}

export function updatePairedTaskInDatabase(
  database: Database,
  id: string,
  updates: PairedTaskUpdates,
): boolean {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.source_ref !== undefined) {
    fields.push('source_ref = ?');
    values.push(updates.source_ref);
  }
  if (updates.plan_notes !== undefined) {
    fields.push('plan_notes = ?');
    values.push(updates.plan_notes);
  }
  if (updates.review_requested_at !== undefined) {
    fields.push('review_requested_at = ?');
    values.push(updates.review_requested_at);
  }
  if (updates.round_trip_count !== undefined) {
    fields.push('round_trip_count = ?');
    values.push(updates.round_trip_count);
  }
  if (updates.owner_failure_count !== undefined) {
    fields.push('owner_failure_count = ?');
    values.push(updates.owner_failure_count);
  }
  if (updates.owner_step_done_streak !== undefined) {
    fields.push('owner_step_done_streak = ?');
    values.push(updates.owner_step_done_streak);
  }
  if (updates.finalize_step_done_count !== undefined) {
    fields.push('finalize_step_done_count = ?');
    values.push(updates.finalize_step_done_count);
  }
  if (updates.task_done_then_user_reopen_count !== undefined) {
    fields.push('task_done_then_user_reopen_count = ?');
    values.push(updates.task_done_then_user_reopen_count);
  }
  if (updates.empty_step_done_streak !== undefined) {
    fields.push('empty_step_done_streak = ?');
    values.push(updates.empty_step_done_streak);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.arbiter_verdict !== undefined) {
    fields.push('arbiter_verdict = ?');
    values.push(updates.arbiter_verdict);
  }
  if (updates.arbiter_requested_at !== undefined) {
    fields.push('arbiter_requested_at = ?');
    values.push(updates.arbiter_requested_at);
  }
  if (updates.completion_reason !== undefined) {
    fields.push('completion_reason = ?');
    values.push(updates.completion_reason);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }

  if (fields.length === 0) return false;

  values.push(id);
  const result = database
    .prepare(`UPDATE paired_tasks SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  return result.changes > 0;
}

export function updatePairedTaskIfUnchangedInDatabase(
  database: Database,
  id: string,
  expectedUpdatedAt: string,
  updates: PairedTaskUpdates,
): boolean {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.source_ref !== undefined) {
    fields.push('source_ref = ?');
    values.push(updates.source_ref);
  }
  if (updates.plan_notes !== undefined) {
    fields.push('plan_notes = ?');
    values.push(updates.plan_notes);
  }
  if (updates.review_requested_at !== undefined) {
    fields.push('review_requested_at = ?');
    values.push(updates.review_requested_at);
  }
  if (updates.round_trip_count !== undefined) {
    fields.push('round_trip_count = ?');
    values.push(updates.round_trip_count);
  }
  if (updates.owner_failure_count !== undefined) {
    fields.push('owner_failure_count = ?');
    values.push(updates.owner_failure_count);
  }
  if (updates.owner_step_done_streak !== undefined) {
    fields.push('owner_step_done_streak = ?');
    values.push(updates.owner_step_done_streak);
  }
  if (updates.finalize_step_done_count !== undefined) {
    fields.push('finalize_step_done_count = ?');
    values.push(updates.finalize_step_done_count);
  }
  if (updates.task_done_then_user_reopen_count !== undefined) {
    fields.push('task_done_then_user_reopen_count = ?');
    values.push(updates.task_done_then_user_reopen_count);
  }
  if (updates.empty_step_done_streak !== undefined) {
    fields.push('empty_step_done_streak = ?');
    values.push(updates.empty_step_done_streak);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.arbiter_verdict !== undefined) {
    fields.push('arbiter_verdict = ?');
    values.push(updates.arbiter_verdict);
  }
  if (updates.arbiter_requested_at !== undefined) {
    fields.push('arbiter_requested_at = ?');
    values.push(updates.arbiter_requested_at);
  }
  if (updates.completion_reason !== undefined) {
    fields.push('completion_reason = ?');
    values.push(updates.completion_reason);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }

  if (fields.length === 0) return false;

  values.push(id, expectedUpdatedAt);
  const result = database
    .prepare(
      `UPDATE paired_tasks SET ${fields.join(', ')} WHERE id = ? AND updated_at = ?`,
    )
    .run(...values);
  return result.changes > 0;
}
