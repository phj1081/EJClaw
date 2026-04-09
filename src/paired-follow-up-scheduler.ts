import {
  _clearPairedTurnReservationsForTests,
  claimPairedTurnReservation,
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

export function resetPairedFollowUpScheduleState(): void {
  _clearPairedTurnReservationsForTests();
}
