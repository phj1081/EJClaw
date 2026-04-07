import type { PairedTask, PairedTaskStatus } from './types.js';

export type ScheduledPairedFollowUpIntentKind =
  | 'reviewer-turn'
  | 'arbiter-turn'
  | 'owner-follow-up'
  | 'finalize-owner-turn';

type ScheduledPairedFollowUpTask = Pick<
  PairedTask,
  'id' | 'status' | 'round_trip_count'
>;

export const SCHEDULED_PAIRED_FOLLOW_UP_TTL_MS = 10 * 60 * 1000;
const scheduledPairedFollowUps = new Map<string, number>();

function pruneExpiredScheduledPairedFollowUps(now: number): void {
  for (const [key, scheduledAt] of scheduledPairedFollowUps) {
    if (now - scheduledAt > SCHEDULED_PAIRED_FOLLOW_UP_TTL_MS) {
      scheduledPairedFollowUps.delete(key);
    }
  }
}

export function buildPairedFollowUpKey(args: {
  taskId: string;
  taskStatus: PairedTaskStatus | null;
  roundTripCount: number;
  intentKind: ScheduledPairedFollowUpIntentKind;
}): string {
  return [
    args.taskId,
    args.taskStatus ?? 'unknown',
    String(args.roundTripCount),
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
  const now = Date.now();
  pruneExpiredScheduledPairedFollowUps(now);

  const key = [
    args.chatJid,
    buildPairedFollowUpKey({
      taskId: args.task.id,
      taskStatus: args.task.status,
      roundTripCount: args.task.round_trip_count,
      intentKind: args.intentKind,
    }),
  ].join(':');

  if (scheduledPairedFollowUps.has(key)) {
    return false;
  }

  scheduledPairedFollowUps.set(key, now);
  args.enqueue();
  return true;
}

export function resetPairedFollowUpScheduleState(): void {
  scheduledPairedFollowUps.clear();
}
