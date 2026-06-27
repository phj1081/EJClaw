import {
  _clearPairedTurnReservationsForTests,
  claimPairedTurnReservation,
  clearStalePendingPairedTurnReservations,
  getRecoverablePendingPairedTurnReservations,
  reservePairedTurnReservation,
} from './db.js';
import type {
  PairedTask,
  PairedTaskStatus,
  PairedTurnReservationIntentKind,
} from './types.js';

export type ScheduledPairedFollowUpIntentKind =
  | 'reviewer-turn'
  | 'arbiter-turn'
  | 'owner-follow-up'
  | 'finalize-owner-turn';

type ScheduledPairedFollowUpTask = Pick<
  PairedTask,
  'id' | 'status' | 'round_trip_count' | 'updated_at'
>;

const enqueuedPendingReservationKeys = new Set<string>();

export function buildPairedFollowUpKey(args: {
  taskId: string;
  taskStatus: PairedTaskStatus | null;
  roundTripCount: number;
  taskUpdatedAt: string | null | undefined;
  intentKind: ScheduledPairedFollowUpIntentKind;
}): string {
  return [
    args.taskId,
    args.taskStatus ?? 'unknown',
    String(args.roundTripCount),
    args.taskUpdatedAt ?? 'unknown',
    args.intentKind,
  ].join(':');
}

export function schedulePairedFollowUpOnce(args: {
  chatJid: string;
  runId: string;
  task: ScheduledPairedFollowUpTask;
  intentKind: ScheduledPairedFollowUpIntentKind;
  enqueue: () => void;
}): boolean {
  const reservationKey = buildPairedFollowUpKey({
    taskId: args.task.id,
    taskStatus: args.task.status,
    roundTripCount: args.task.round_trip_count,
    taskUpdatedAt: args.task.updated_at,
    intentKind: args.intentKind,
  });
  const reserved = reservePairedTurnReservation({
    chatJid: args.chatJid,
    taskId: args.task.id,
    taskStatus: args.task.status,
    roundTripCount: args.task.round_trip_count,
    taskUpdatedAt: args.task.updated_at,
    intentKind: args.intentKind,
    runId: args.runId,
  });

  if (!reserved) {
    return false;
  }

  enqueuedPendingReservationKeys.add(reservationKey);
  args.enqueue();
  return true;
}

export function claimPairedTurnExecution(args: {
  chatJid: string;
  runId: string;
  task: ScheduledPairedFollowUpTask;
  intentKind: PairedTurnReservationIntentKind;
}): boolean {
  return claimPairedTurnReservation({
    chatJid: args.chatJid,
    taskId: args.task.id,
    taskStatus: args.task.status,
    roundTripCount: args.task.round_trip_count,
    taskUpdatedAt: args.task.updated_at,
    intentKind: args.intentKind,
    runId: args.runId,
  });
}

export function clearStalePendingPairedFollowUpReservations(): number {
  return clearStalePendingPairedTurnReservations();
}

export function requeueRecoverablePendingPairedFollowUps(args: {
  enqueue: (chatJid: string, groupFolder: string) => void;
  onRequeued?: (reservation: {
    chat_jid: string;
    task_id: string;
    group_folder: string;
    task_status: PairedTaskStatus;
    intent_kind: PairedTurnReservationIntentKind;
    scheduled_run_id: string;
    updated_at: string;
  }) => void;
}): number {
  const reservations = getRecoverablePendingPairedTurnReservations();
  let requeuedCount = 0;
  for (const reservation of reservations) {
    const reservationKey = buildPairedFollowUpKey({
      taskId: reservation.task_id,
      taskStatus: reservation.task_status,
      roundTripCount: reservation.round_trip_count,
      taskUpdatedAt: reservation.task_updated_at,
      intentKind: reservation.intent_kind as ScheduledPairedFollowUpIntentKind,
    });
    if (enqueuedPendingReservationKeys.has(reservationKey)) {
      continue;
    }
    enqueuedPendingReservationKeys.add(reservationKey);
    args.enqueue(reservation.chat_jid, reservation.group_folder);
    args.onRequeued?.(reservation);
    requeuedCount += 1;
  }
  return requeuedCount;
}

export function resetPairedFollowUpScheduleState(): void {
  enqueuedPendingReservationKeys.clear();
  _clearPairedTurnReservationsForTests();
}
