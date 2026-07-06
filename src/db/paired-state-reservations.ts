import { Database } from 'bun:sqlite';

import { SERVICE_ID, normalizeServiceId } from '../config.js';
import {
  buildPairedTurnIdentity,
  resolvePairedTurnRole,
} from '../paired-turn-identity.js';
import { ensurePairedTurnQueuedInDatabase } from './paired-turns.js';
import { PairedTaskStatus, PairedTurnReservationIntentKind } from '../types.js';

export const PAIRED_TASK_EXECUTION_LEASE_TTL_MS = 10 * 60_000;
export const CURRENT_SERVICE_ID = normalizeServiceId(SERVICE_ID);

export interface RecoverablePendingPairedTurnReservation {
  chat_jid: string;
  task_id: string;
  group_folder: string;
  task_status: PairedTaskStatus;
  live_task_status: PairedTaskStatus;
  round_trip_count: number;
  task_updated_at: string;
  intent_kind: PairedTurnReservationIntentKind;
  turn_role: 'owner' | 'reviewer' | 'arbiter';
  scheduled_run_id: string;
  updated_at: string;
}

export function computeExecutionLeaseExpiry(now: string): string {
  return new Date(
    new Date(now).getTime() + PAIRED_TASK_EXECUTION_LEASE_TTL_MS,
  ).toISOString();
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
  const turnIdentity = buildPairedTurnIdentity({
    taskId: args.taskId,
    taskUpdatedAt: args.taskUpdatedAt,
    intentKind: args.intentKind,
    role: resolvePairedTurnRole(args.intentKind),
  });
  const result = database
    .prepare(
      `
        INSERT INTO paired_turn_reservations (
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
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'pending', ?, NULL, ?, ?, NULL)
        ON CONFLICT(chat_jid, task_id, task_updated_at, intent_kind) DO UPDATE SET
          task_status = excluded.task_status,
          round_trip_count = excluded.round_trip_count,
          turn_id = excluded.turn_id,
          turn_attempt_id = NULL,
          turn_attempt_no = NULL,
          turn_role = excluded.turn_role,
          status = 'pending',
          scheduled_run_id = excluded.scheduled_run_id,
          consumed_run_id = NULL,
          updated_at = excluded.updated_at,
          consumed_at = NULL
        WHERE paired_turn_reservations.status = 'completed'
          AND EXISTS (
            SELECT 1
              FROM paired_turn_attempts latest_attempt
             WHERE latest_attempt.turn_id = paired_turn_reservations.turn_id
               AND latest_attempt.state = 'failed'
               AND NOT EXISTS (
                 SELECT 1
                   FROM paired_turn_attempts newer_attempt
                  WHERE newer_attempt.turn_id = latest_attempt.turn_id
                    AND newer_attempt.attempt_no > latest_attempt.attempt_no
               )
          )
      `,
    )
    .run(
      args.chatJid,
      args.taskId,
      args.taskStatus,
      args.roundTripCount,
      args.taskUpdatedAt,
      turnIdentity.turnId,
      turnIdentity.role,
      args.intentKind,
      args.runId,
      now,
      now,
    );

  if (result.changes > 0) {
    ensurePairedTurnQueuedInDatabase(database, turnIdentity);
    return true;
  }

  return false;
}

export function clearStalePendingPairedTurnReservationsInDatabase(
  database: Database,
): number {
  return database
    .prepare(
      `
        DELETE FROM paired_turn_reservations
         WHERE status = 'pending'
           AND task_id IN (
             SELECT r.task_id
               FROM paired_turn_reservations r
               LEFT JOIN paired_tasks t ON t.id = r.task_id
              WHERE r.status = 'pending'
                AND (
                  t.id IS NULL
                  OR t.status IN ('completed', 'cancelled', 'failed')
                )
           )
      `,
    )
    .run().changes;
}

export function getRecoverablePendingPairedTurnReservationsFromDatabase(
  database: Database,
): RecoverablePendingPairedTurnReservation[] {
  return database
    .prepare(
      `
        SELECT
          r.chat_jid,
          r.task_id,
          t.group_folder,
          r.task_status,
          t.status AS live_task_status,
          r.round_trip_count,
          r.task_updated_at,
          r.intent_kind,
          r.turn_role,
          r.scheduled_run_id,
          r.updated_at
        FROM paired_turn_reservations r
        JOIN paired_tasks t ON t.id = r.task_id
        LEFT JOIN paired_task_execution_leases l ON l.task_id = r.task_id
       WHERE r.status = 'pending'
         AND l.task_id IS NULL
         AND t.status NOT IN ('completed', 'cancelled', 'failed')
         AND r.task_status = t.status
         AND r.task_updated_at = t.updated_at
         AND (
           (t.status = 'active' AND r.intent_kind = 'owner-follow-up')
           OR (t.status IN ('review_ready', 'in_review') AND r.intent_kind = 'reviewer-turn')
           OR (t.status IN ('arbiter_requested', 'in_arbitration') AND r.intent_kind = 'arbiter-turn')
           OR (t.status = 'merge_ready' AND r.intent_kind = 'finalize-owner-turn')
         )
         AND NOT EXISTS (
           SELECT 1
             FROM paired_turn_attempts a
            WHERE a.turn_id = r.turn_id
              AND a.state IN ('running', 'delegated')
         )
       ORDER BY r.updated_at ASC
      `,
    )
    .all() as RecoverablePendingPairedTurnReservation[];
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
