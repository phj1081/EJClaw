import { Database } from 'bun:sqlite';

import {
  ARBITER_AGENT_TYPE,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  SERVICE_ID,
  normalizeServiceId,
} from '../config.js';
import {
  resolveStablePairedTaskOwnerAgentType,
  resolveStableReviewerAgentType,
} from './legacy-rebuilds.js';
import { normalizeStoredAgentType } from './room-registration.js';
import {
  inferAgentTypeFromServiceShadow,
  resolveRoleServiceShadow,
} from '../role-service-shadow.js';
import {
  AgentType,
  PairedProject,
  PairedRoomRole,
  PairedTask,
  PairedTaskStatus,
  PairedTurnReservationIntentKind,
  PairedWorkspace,
} from '../types.js';

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
    | 'status'
    | 'arbiter_verdict'
    | 'arbiter_requested_at'
    | 'completion_reason'
    | 'updated_at'
  >
>;

export const PAIRED_TASK_EXECUTION_LEASE_TTL_MS = 10 * 60_000;
const CURRENT_SERVICE_ID = normalizeServiceId(SERVICE_ID);

function computeExecutionLeaseExpiry(now: string): string {
  return new Date(
    new Date(now).getTime() + PAIRED_TASK_EXECUTION_LEASE_TTL_MS,
  ).toISOString();
}

function resolveExecutionLeaseRole(
  intentKind: PairedTurnReservationIntentKind,
): PairedRoomRole {
  switch (intentKind) {
    case 'reviewer-turn':
      return 'reviewer';
    case 'arbiter-turn':
      return 'arbiter';
    case 'owner-turn':
    case 'owner-follow-up':
    case 'finalize-owner-turn':
    default:
      return 'owner';
  }
}

function hydratePairedTaskRow(
  database: Database,
  row: StoredPairedTaskRow,
): PairedTask {
  const persistedOwnerAgentType = normalizeStoredAgentType(
    row.owner_agent_type ?? null,
  );
  const persistedReviewerAgentType = normalizeStoredAgentType(
    row.reviewer_agent_type ?? null,
  );
  const stableOwnerAgentType = resolveStablePairedTaskOwnerAgentType(
    database,
    row,
  );
  const ownerAgentType =
    stableOwnerAgentType ??
    (row.owner_service_id
      ? inferAgentTypeFromServiceShadow(row.owner_service_id)
      : undefined);
  const stableReviewerAgentType = resolveStableReviewerAgentType(
    stableOwnerAgentType,
    row.reviewer_agent_type ?? null,
  );
  const reviewerAgentType =
    persistedReviewerAgentType ??
    stableReviewerAgentType ??
    (row.reviewer_service_id
      ? inferAgentTypeFromServiceShadow(row.reviewer_service_id)
      : null) ??
    resolveStableReviewerAgentType(ownerAgentType, null);
  const arbiterAgentType =
    normalizeStoredAgentType(row.arbiter_agent_type) ??
    ARBITER_AGENT_TYPE ??
    null;

  return {
    ...row,
    owner_service_id:
      row.owner_service_id ??
      resolveRoleServiceShadow('owner', ownerAgentType) ??
      CODEX_MAIN_SERVICE_ID,
    reviewer_service_id:
      row.reviewer_service_id ??
      resolveRoleServiceShadow('reviewer', reviewerAgentType) ??
      CODEX_REVIEW_SERVICE_ID,
    owner_agent_type: ownerAgentType ?? null,
    reviewer_agent_type: reviewerAgentType ?? null,
    arbiter_agent_type: arbiterAgentType,
  };
}

export function upsertPairedProjectInDatabase(
  database: Database,
  project: PairedProject,
): void {
  database
    .prepare(
      `
        INSERT INTO paired_projects (
          chat_jid,
          group_folder,
          canonical_work_dir,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chat_jid) DO UPDATE SET
          group_folder = excluded.group_folder,
          canonical_work_dir = excluded.canonical_work_dir,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      project.chat_jid,
      project.group_folder,
      project.canonical_work_dir,
      project.created_at,
      project.updated_at,
    );
}

export function getPairedProjectFromDatabase(
  database: Database,
  chatJid: string,
): PairedProject | undefined {
  return database
    .prepare('SELECT * FROM paired_projects WHERE chat_jid = ?')
    .get(chatJid) as PairedProject | undefined;
}

export function createPairedTaskInDatabase(
  database: Database,
  task: PairedTask,
): void {
  const ownerAgentType =
    normalizeStoredAgentType(task.owner_agent_type) ??
    inferAgentTypeFromServiceShadow(task.owner_service_id) ??
    null;
  const reviewerAgentType =
    normalizeStoredAgentType(task.reviewer_agent_type) ??
    inferAgentTypeFromServiceShadow(task.reviewer_service_id) ??
    resolveStableReviewerAgentType(ownerAgentType ?? undefined, null);
  const arbiterAgentType =
    normalizeStoredAgentType(task.arbiter_agent_type) ??
    ARBITER_AGENT_TYPE ??
    null;
  const ownerServiceId =
    task.owner_service_id ??
    resolveRoleServiceShadow('owner', ownerAgentType) ??
    CODEX_MAIN_SERVICE_ID;
  const reviewerServiceId =
    task.reviewer_service_id ??
    resolveRoleServiceShadow('reviewer', reviewerAgentType) ??
    CODEX_REVIEW_SERVICE_ID;

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
          status,
          arbiter_verdict,
          arbiter_requested_at,
          completion_reason,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

export function getLatestPairedTaskForChatFromDatabase(
  database: Database,
  chatJid: string,
): PairedTask | undefined {
  const row = database
    .prepare(
      `
        SELECT *
          FROM paired_tasks
         WHERE chat_jid = ?
         ORDER BY updated_at DESC
         LIMIT 1
      `,
    )
    .get(chatJid) as StoredPairedTaskRow | undefined;
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

export function reservePairedTurnReservationInDatabase(
  database: Database,
  args: {
    chatJid: string;
    taskId: string;
    taskStatus: PairedTaskStatus;
    roundTripCount: number;
    taskUpdatedAt: string;
    intentKind: PairedTurnReservationIntentKind;
    runId: string;
  },
): boolean {
  const now = new Date().toISOString();
  const result = database
    .prepare(
      `
        INSERT INTO paired_turn_reservations (
          chat_jid,
          task_id,
          task_status,
          round_trip_count,
          task_updated_at,
          intent_kind,
          status,
          scheduled_run_id,
          consumed_run_id,
          created_at,
          updated_at,
          consumed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, NULL)
        ON CONFLICT(chat_jid, task_id, task_updated_at, intent_kind) DO NOTHING
      `,
    )
    .run(
      args.chatJid,
      args.taskId,
      args.taskStatus,
      args.roundTripCount,
      args.taskUpdatedAt,
      args.intentKind,
      args.runId,
      now,
      now,
    );

  return result.changes > 0;
}

class PairedTurnReservationClaimError extends Error {}

export function claimPairedTurnReservationInDatabase(
  database: Database,
  args: {
    chatJid: string;
    taskId: string;
    taskStatus: PairedTaskStatus;
    roundTripCount: number;
    taskUpdatedAt: string;
    intentKind: PairedTurnReservationIntentKind;
    runId: string;
  },
): boolean {
  const tx = database.transaction(() => {
    const now = new Date().toISOString();
    const expiresAt = computeExecutionLeaseExpiry(now);
    const leaseRole = resolveExecutionLeaseRole(args.intentKind);
    const existingLease = database
      .prepare(
        `
          SELECT claimed_run_id, updated_at, expires_at
            FROM paired_task_execution_leases
           WHERE task_id = ?
        `,
      )
      .get(args.taskId) as
      | {
          claimed_run_id: string;
          claimed_service_id: string;
          updated_at: string;
          expires_at: string;
        }
      | undefined;

    if (!existingLease) {
      const insertedLease = database
        .prepare(
          `
            INSERT INTO paired_task_execution_leases (
              task_id,
              chat_jid,
              role,
              intent_kind,
              claimed_run_id,
              claimed_service_id,
              task_status,
              task_updated_at,
              claimed_at,
              updated_at,
              expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          args.taskId,
          args.chatJid,
          leaseRole,
          args.intentKind,
          args.runId,
          CURRENT_SERVICE_ID,
          args.taskStatus,
          args.taskUpdatedAt,
          now,
          now,
          expiresAt,
        );

      if (insertedLease.changes === 0) {
        throw new PairedTurnReservationClaimError();
      }
    } else if (existingLease.expires_at > now) {
      throw new PairedTurnReservationClaimError();
    } else {
      const tookOverLease = database
        .prepare(
          `
            UPDATE paired_task_execution_leases
               SET chat_jid = ?,
                   role = ?,
                   intent_kind = ?,
                   claimed_run_id = ?,
                   claimed_service_id = ?,
                   task_status = ?,
                   task_updated_at = ?,
                   claimed_at = ?,
                   updated_at = ?,
                   expires_at = ?
             WHERE task_id = ?
               AND claimed_run_id = ?
               AND updated_at = ?
               AND expires_at = ?
          `,
        )
        .run(
          args.chatJid,
          leaseRole,
          args.intentKind,
          args.runId,
          CURRENT_SERVICE_ID,
          args.taskStatus,
          args.taskUpdatedAt,
          now,
          now,
          expiresAt,
          args.taskId,
          existingLease.claimed_run_id,
          existingLease.updated_at,
          existingLease.expires_at,
        );

      if (tookOverLease.changes === 0) {
        throw new PairedTurnReservationClaimError();
      }
    }

    database
      .prepare(
        `
          UPDATE paired_turn_reservations
             SET status = 'completed',
                 consumed_run_id = ?,
                 updated_at = ?,
                 consumed_at = ?
           WHERE chat_jid = ?
             AND task_id = ?
             AND task_updated_at = ?
             AND intent_kind = ?
             AND status = 'pending'
        `,
      )
      .run(
        args.runId,
        now,
        now,
        args.chatJid,
        args.taskId,
        args.taskUpdatedAt,
        args.intentKind,
      );

    const claimedTask = database
      .prepare(
        `
          UPDATE paired_tasks
             SET updated_at = updated_at
           WHERE id = ?
             AND updated_at = ?
             AND status = ?
        `,
      )
      .run(args.taskId, args.taskUpdatedAt, args.taskStatus);

    if (claimedTask.changes === 0) {
      throw new PairedTurnReservationClaimError();
    }
  });

  try {
    tx();
    return true;
  } catch (error) {
    if (error instanceof PairedTurnReservationClaimError) {
      return false;
    }
    throw error;
  }
}

export function clearPairedTurnReservationsInDatabase(
  database: Database,
): void {
  database.prepare('DELETE FROM paired_turn_reservations').run();
}

export function releasePairedTaskExecutionLeaseInDatabase(
  database: Database,
  args: {
    taskId: string;
    runId: string;
  },
): void {
  database
    .prepare(
      `
        DELETE FROM paired_task_execution_leases
         WHERE task_id = ?
           AND claimed_service_id = ?
           AND claimed_run_id = ?
      `,
    )
    .run(args.taskId, CURRENT_SERVICE_ID, args.runId);
}

export function refreshPairedTaskExecutionLeaseInDatabase(
  database: Database,
  args: {
    taskId: string;
    runId: string;
    now?: string;
  },
): boolean {
  const now = args.now ?? new Date().toISOString();
  const result = database
    .prepare(
      `
        UPDATE paired_task_execution_leases
           SET updated_at = ?,
               expires_at = ?
         WHERE task_id = ?
           AND claimed_service_id = ?
           AND claimed_run_id = ?
           AND expires_at >= ?
      `,
    )
    .run(
      now,
      computeExecutionLeaseExpiry(now),
      args.taskId,
      CURRENT_SERVICE_ID,
      args.runId,
      now,
    );
  return result.changes > 0;
}

export function clearPairedTaskExecutionLeasesForServiceInDatabase(
  database: Database,
  serviceId: string = CURRENT_SERVICE_ID,
): number {
  return database
    .prepare(
      `
        DELETE FROM paired_task_execution_leases
         WHERE claimed_service_id = ?
      `,
    )
    .run(serviceId).changes;
}

export function clearExpiredPairedTaskExecutionLeasesInDatabase(
  database: Database,
  now: string = new Date().toISOString(),
): number {
  return database
    .prepare(
      `
        DELETE FROM paired_task_execution_leases
         WHERE expires_at <= ?
      `,
    )
    .run(now).changes;
}

export function clearPairedTaskExecutionLeasesInDatabase(
  database: Database,
): void {
  database.prepare('DELETE FROM paired_task_execution_leases').run();
}

export function upsertPairedWorkspaceInDatabase(
  database: Database,
  workspace: PairedWorkspace,
): void {
  database
    .prepare(
      `
        INSERT INTO paired_workspaces (
          id,
          task_id,
          role,
          workspace_dir,
          snapshot_source_dir,
          snapshot_ref,
          status,
          snapshot_refreshed_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workspace_dir = excluded.workspace_dir,
          snapshot_source_dir = excluded.snapshot_source_dir,
          snapshot_ref = excluded.snapshot_ref,
          status = excluded.status,
          snapshot_refreshed_at = excluded.snapshot_refreshed_at,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      workspace.id,
      workspace.task_id,
      workspace.role,
      workspace.workspace_dir,
      workspace.snapshot_source_dir,
      workspace.snapshot_ref,
      workspace.status,
      workspace.snapshot_refreshed_at,
      workspace.created_at,
      workspace.updated_at,
    );
}

export function getPairedWorkspaceFromDatabase(
  database: Database,
  taskId: string,
  role: PairedWorkspace['role'],
): PairedWorkspace | undefined {
  return database
    .prepare('SELECT * FROM paired_workspaces WHERE task_id = ? AND role = ?')
    .get(taskId, role) as PairedWorkspace | undefined;
}

export function listPairedWorkspacesForTaskFromDatabase(
  database: Database,
  taskId: string,
): PairedWorkspace[] {
  return database
    .prepare(
      'SELECT * FROM paired_workspaces WHERE task_id = ? ORDER BY created_at',
    )
    .all(taskId) as PairedWorkspace[];
}

export function getLastBotFinalMessageFromDatabase(
  database: Database,
  chatJid: string,
  _agentType: AgentType = 'claude-code',
  limit: number = 1,
): Array<{ content: string; timestamp: string }> {
  return database
    .prepare(
      `SELECT content, timestamp
       FROM messages
       WHERE chat_jid = ? AND is_bot_message = 1
       ORDER BY timestamp DESC, seq DESC
       LIMIT ?`,
    )
    .all(chatJid, limit) as Array<{ content: string; timestamp: string }>;
}
