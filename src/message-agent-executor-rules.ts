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
  | 'generic'
  | 'pending'
  | 'skip-inline-finalize'
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
    if (nextTurnAction.kind === 'reviewer-turn') {
      return 'generic';
    }

    return args.completedRole === 'reviewer' &&
      nextTurnAction.kind === 'finalize-owner-turn'
      ? 'skip-inline-finalize'
      : 'none';
  }

  const shouldRequeuePendingPairedTurn =
    (args.completedRole === 'reviewer' || args.completedRole === 'arbiter') &&
    (nextTurnAction.kind === 'reviewer-turn' ||
      nextTurnAction.kind === 'arbiter-turn' ||
      nextTurnAction.kind === 'finalize-owner-turn');
  return shouldRequeuePendingPairedTurn ? 'pending' : 'none';
}
