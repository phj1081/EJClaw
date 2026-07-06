import { Database } from 'bun:sqlite';

import { CURRENT_RUNTIME_AGENT_TYPE } from '../config.js';
import {
  buildPairedTurnIdentity,
  resolvePairedTurnRole,
} from '../paired-turn-identity.js';
import {
  CURRENT_SERVICE_ID,
  computeExecutionLeaseExpiry,
} from './paired-state-reservations.js';
import { markPairedTurnRunningInDatabase } from './paired-turns.js';
import {
  AgentType,
  PairedTaskStatus,
  PairedTurnReservationIntentKind,
} from '../types.js';

export {
  createPairedTaskInDatabase,
  getAllOpenPairedTasksFromDatabase,
  getLatestOpenPairedTaskForChatFromDatabase,
  getLatestPairedTaskForChatFromDatabase,
  getLatestPreviousPairedTaskForChatFromDatabase,
  getPairedTaskByIdFromDatabase,
  updatePairedTaskIfUnchangedInDatabase,
  updatePairedTaskInDatabase,
  type PairedTaskUpdates,
} from './paired-state-tasks.js';
export {
  PAIRED_TASK_EXECUTION_LEASE_TTL_MS,
  clearExpiredPairedTaskExecutionLeasesInDatabase,
  clearPairedTaskExecutionLeasesForServiceInDatabase,
  clearPairedTaskExecutionLeasesInDatabase,
  clearPairedTurnReservationsInDatabase,
  clearStalePendingPairedTurnReservationsInDatabase,
  getRecoverablePendingPairedTurnReservationsFromDatabase,
  refreshPairedTaskExecutionLeaseInDatabase,
  releasePairedTaskExecutionLeaseInDatabase,
  reservePairedTurnReservationInDatabase,
  type RecoverablePendingPairedTurnReservation,
} from './paired-state-reservations.js';
export {
  getPairedProjectFromDatabase,
  getPairedWorkspaceFromDatabase,
  listPairedWorkspacesForTaskFromDatabase,
  upsertPairedProjectInDatabase,
  upsertPairedWorkspaceInDatabase,
} from './paired-state-workspaces.js';

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
    const turnIdentity = buildPairedTurnIdentity({
      taskId: args.taskId,
      taskUpdatedAt: args.taskUpdatedAt,
      intentKind: args.intentKind,
      role: resolvePairedTurnRole(args.intentKind),
    });
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
            VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          args.taskId,
          args.chatJid,
          turnIdentity.role,
          turnIdentity.turnId,
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
                   turn_id = ?,
                   turn_attempt_id = NULL,
                   turn_attempt_no = NULL,
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
          turnIdentity.role,
          turnIdentity.turnId,
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

    const currentAttempt = markPairedTurnRunningInDatabase(database, {
      turnIdentity,
      executorServiceId: CURRENT_SERVICE_ID,
      executorAgentType: CURRENT_RUNTIME_AGENT_TYPE,
      runId: args.runId,
    });
    if (!currentAttempt) {
      throw new Error(
        `paired_turns(${turnIdentity.turnId}) did not materialize a running attempt row`,
      );
    }
    const turnAttemptNo = currentAttempt.attempt_no;
    const turnAttemptId = currentAttempt.attempt_id;

    database
      .prepare(
        `
          UPDATE paired_task_execution_leases
             SET turn_attempt_id = ?,
                 turn_attempt_no = ?
           WHERE task_id = ?
             AND claimed_service_id = ?
             AND claimed_run_id = ?
        `,
      )
      .run(
        turnAttemptId,
        turnAttemptNo,
        args.taskId,
        CURRENT_SERVICE_ID,
        args.runId,
      );

    database
      .prepare(
        `
          UPDATE paired_turn_reservations
             SET status = 'completed',
                 turn_attempt_id = ?,
                 turn_attempt_no = ?,
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
        turnAttemptId,
        turnAttemptNo,
        args.runId,
        now,
        now,
        args.chatJid,
        args.taskId,
        args.taskUpdatedAt,
        args.intentKind,
      );
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
