import {
  resolveFollowUpDispatch,
  resolveNextTurnAction,
} from './message-runtime-rules.js';
import { parseVisibleVerdict } from './paired-verdict.js';
import type { PairedRoomRole, PairedTaskStatus } from './types.js';
export {
  isRetryableClaudeSessionFailureAttempt,
  resolveAttemptRetryAction,
  resolveClaudeRetryTrigger,
  resolveCodexRetryTrigger,
  type AttemptRetryAction,
  type AttemptRetryState as ExecutorAttemptState,
  type AttemptStreamedTrigger as ExecutorStreamedTrigger,
} from './agent-attempt-retry.js';

export type PairedFollowUpQueueAction = 'pending' | 'none';

export function resolvePairedFollowUpQueueAction(args: {
  completedRole: PairedRoomRole;
  executionStatus: 'succeeded' | 'failed';
  sawOutput: boolean;
  taskStatus: PairedTaskStatus | null;
  outputSummary?: string | null;
}): PairedFollowUpQueueAction {
  const nextTurnAction = resolveNextTurnAction({
    taskStatus: args.taskStatus,
    lastTurnOutputRole: args.sawOutput ? args.completedRole : null,
    lastTurnOutputVerdict:
      args.sawOutput && args.outputSummary
        ? parseVisibleVerdict(args.outputSummary)
        : null,
  });
  const dispatch = resolveFollowUpDispatch({
    source: 'executor-recovery',
    nextTurnAction,
    completedRole: args.completedRole,
    executionStatus: args.executionStatus,
    sawOutput: args.sawOutput,
  });
  return dispatch.kind === 'enqueue' &&
    dispatch.queueKind === 'paired-follow-up'
    ? 'pending'
    : 'none';
}
