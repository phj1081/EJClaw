import { resolveNextTurnAction } from './message-runtime-rules.js';
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

export type PairedFollowUpQueueAction =
  | 'pending'
  | 'none';

export function resolvePairedFollowUpQueueAction(args: {
  completedRole: PairedRoomRole;
  executionStatus: 'succeeded' | 'failed';
  sawOutput: boolean;
  taskStatus: PairedTaskStatus | null;
}): PairedFollowUpQueueAction {
  const nextTurnAction = resolveNextTurnAction({
    taskStatus: args.taskStatus,
    lastTurnOutputRole:
      args.executionStatus === 'succeeded' && args.sawOutput
        ? args.completedRole
        : null,
  });

  if (args.executionStatus === 'succeeded' && args.sawOutput) {
    return 'none';
  }

  const shouldRequeuePendingPairedTurn =
    (args.completedRole === 'reviewer' || args.completedRole === 'arbiter') &&
    (nextTurnAction.kind === 'reviewer-turn' ||
      nextTurnAction.kind === 'arbiter-turn' ||
      nextTurnAction.kind === 'finalize-owner-turn');
  return shouldRequeuePendingPairedTurn ? 'pending' : 'none';
}
