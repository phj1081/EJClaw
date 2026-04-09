import { getPairedTurnOutputs } from './db.js';
import {
  matchesExpectedPairedFollowUpIntent,
  resolveFollowUpDispatch,
  resolveNextTurnAction,
  type FollowUpDispatch,
  type NextTurnAction,
} from './message-runtime-rules.js';
import {
  schedulePairedFollowUpOnce,
  type ScheduledPairedFollowUpIntentKind,
} from './paired-follow-up-scheduler.js';
import type { PairedRoomRole, PairedTask, PairedTaskStatus } from './types.js';

export type PairedFollowUpSource = Parameters<
  typeof resolveFollowUpDispatch
>[0]['source'];

export interface PairedFollowUpDecision {
  taskId: string | null;
  taskStatus: PairedTaskStatus | null;
  lastTurnOutputRole: PairedRoomRole | null;
  nextTurnAction: NextTurnAction;
  dispatch: FollowUpDispatch;
}

export type PairedFollowUpDispatchResult =
  | (PairedFollowUpDecision & {
      kind: 'none';
    })
  | (PairedFollowUpDecision & {
      kind: 'message-check';
    })
  | (PairedFollowUpDecision & {
      kind: 'paired-follow-up';
      intentKind: ScheduledPairedFollowUpIntentKind;
      scheduled: boolean;
    });

export function resolveLatestPairedTurnOutputRole(args: {
  task: Pick<PairedTask, 'id'> | null | undefined;
  fallbackLastTurnOutputRole?: PairedRoomRole | null;
}): PairedRoomRole | null {
  return (
    (args.task ? getPairedTurnOutputs(args.task.id).at(-1)?.role : null) ??
    args.fallbackLastTurnOutputRole ??
    null
  );
}

export function resolvePairedFollowUpDecision(args: {
  task: Pick<PairedTask, 'id' | 'status'> | null | undefined;
  source: PairedFollowUpSource;
  completedRole?: PairedRoomRole;
  executionStatus?: 'succeeded' | 'failed';
  sawOutput?: boolean;
  fallbackLastTurnOutputRole?: PairedRoomRole | null;
}): PairedFollowUpDecision {
  const lastTurnOutputRole = resolveLatestPairedTurnOutputRole({
    task: args.task,
    fallbackLastTurnOutputRole: args.fallbackLastTurnOutputRole,
  });
  const nextTurnAction = resolveNextTurnAction({
    taskStatus: args.task?.status ?? null,
    lastTurnOutputRole,
  });
  const dispatch = resolveFollowUpDispatch({
    source: args.source,
    nextTurnAction,
    completedRole: args.completedRole,
    executionStatus: args.executionStatus,
    sawOutput: args.sawOutput,
  });

  return {
    taskId: args.task?.id ?? null,
    taskStatus: args.task?.status ?? null,
    lastTurnOutputRole,
    nextTurnAction,
    dispatch,
  };
}

export function schedulePairedFollowUpIntent(args: {
  chatJid: string;
  runId: string;
  task: Pick<
    PairedTask,
    'id' | 'status' | 'round_trip_count' | 'updated_at'
  > | null | undefined;
  intentKind: ScheduledPairedFollowUpIntentKind;
  enqueue: () => void;
  fallbackLastTurnOutputRole?: PairedRoomRole | null;
  lastTurnOutputRole?: PairedRoomRole | null;
}): boolean {
  if (!args.task) {
    return false;
  }

  const lastTurnOutputRole =
    args.lastTurnOutputRole ??
    resolveLatestPairedTurnOutputRole({
      task: args.task,
      fallbackLastTurnOutputRole: args.fallbackLastTurnOutputRole,
    });

  if (
    !matchesExpectedPairedFollowUpIntent({
      taskStatus: args.task.status,
      lastTurnOutputRole,
      intentKind: args.intentKind,
    })
  ) {
    return false;
  }

  return schedulePairedFollowUpOnce({
    chatJid: args.chatJid,
    runId: args.runId,
    task: args.task,
    intentKind: args.intentKind,
    enqueue: args.enqueue,
  });
}

export function schedulePairedFollowUpWithMessageCheck(args: {
  chatJid: string;
  runId: string;
  task: Pick<
    PairedTask,
    'id' | 'status' | 'round_trip_count' | 'updated_at'
  > | null | undefined;
  intentKind: ScheduledPairedFollowUpIntentKind;
  enqueueMessageCheck: () => void;
  fallbackLastTurnOutputRole?: PairedRoomRole | null;
  lastTurnOutputRole?: PairedRoomRole | null;
}): boolean {
  return schedulePairedFollowUpIntent({
    chatJid: args.chatJid,
    runId: args.runId,
    task: args.task,
    intentKind: args.intentKind,
    enqueue: args.enqueueMessageCheck,
    fallbackLastTurnOutputRole: args.fallbackLastTurnOutputRole,
    lastTurnOutputRole: args.lastTurnOutputRole,
  });
}

export function dispatchPairedFollowUpForEvent(args: {
  chatJid: string;
  runId: string;
  task: Pick<
    PairedTask,
    'id' | 'status' | 'round_trip_count' | 'updated_at'
  > | null | undefined;
  source: PairedFollowUpSource;
  completedRole?: PairedRoomRole;
  executionStatus?: 'succeeded' | 'failed';
  sawOutput?: boolean;
  fallbackLastTurnOutputRole?: PairedRoomRole | null;
  enqueue: () => void;
  enqueueMessageCheck?: () => void;
}): PairedFollowUpDispatchResult {
  const decision = resolvePairedFollowUpDecision({
    task: args.task,
    source: args.source,
    completedRole: args.completedRole,
    executionStatus: args.executionStatus,
    sawOutput: args.sawOutput,
    fallbackLastTurnOutputRole: args.fallbackLastTurnOutputRole,
  });

  if (
    decision.dispatch.kind === 'enqueue' &&
    decision.dispatch.queueKind === 'message-check'
  ) {
    args.enqueueMessageCheck?.();
    return {
      kind: 'message-check',
      ...decision,
    };
  }

  if (
    decision.dispatch.kind === 'enqueue' &&
    decision.dispatch.queueKind === 'paired-follow-up' &&
    decision.nextTurnAction.kind !== 'none'
  ) {
    const scheduled = schedulePairedFollowUpIntent({
      chatJid: args.chatJid,
      runId: args.runId,
      task: args.task,
      intentKind: decision.nextTurnAction.kind,
      enqueue: args.enqueue,
      lastTurnOutputRole: decision.lastTurnOutputRole,
    });

    return {
      kind: 'paired-follow-up',
      ...decision,
      intentKind: decision.nextTurnAction.kind,
      scheduled,
    };
  }

  return {
    kind: 'none',
    ...decision,
  };
}

export function enqueuePairedFollowUpAfterEvent(args: {
  chatJid: string;
  runId: string;
  task: Pick<
    PairedTask,
    'id' | 'status' | 'round_trip_count' | 'updated_at'
  > | null | undefined;
  source: PairedFollowUpSource;
  completedRole?: PairedRoomRole;
  executionStatus?: 'succeeded' | 'failed';
  sawOutput?: boolean;
  fallbackLastTurnOutputRole?: PairedRoomRole | null;
  enqueueMessageCheck: () => void;
}): PairedFollowUpDispatchResult {
  return dispatchPairedFollowUpForEvent({
    chatJid: args.chatJid,
    runId: args.runId,
    task: args.task,
    source: args.source,
    completedRole: args.completedRole,
    executionStatus: args.executionStatus,
    sawOutput: args.sawOutput,
    fallbackLastTurnOutputRole: args.fallbackLastTurnOutputRole,
    enqueue: args.enqueueMessageCheck,
    enqueueMessageCheck: args.enqueueMessageCheck,
  });
}

export function requeuePendingPairedTurn(args: {
  schedulePairedFollowUp: () => boolean;
  closeStdin: () => void;
}): boolean {
  const scheduled = args.schedulePairedFollowUp();

  if (scheduled) {
    args.closeStdin();
  }

  return scheduled;
}
