import {
  resolveFollowUpDispatch,
  resolveNextTurnAction,
  shouldRetrySilentOwnerExecution,
} from './message-runtime-rules.js';
import { classifyCodexAuthError } from './agent-error-detection.js';
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

function isSilentCodexAccountFailure(summary?: string | null): boolean {
  if (!summary) return false;
  if (classifyCodexAuthError(summary).category !== 'none') return true;
  const lower = summary.toLowerCase();
  return (
    lower.includes('workspace out of credits') ||
    lower.includes('out of credits') ||
    /all\s+codex(?:\s+rotation)?\s+accounts/i.test(summary)
  );
}

export function resolvePairedFollowUpQueueAction(args: {
  completedRole: PairedRoomRole;
  executionStatus: 'succeeded' | 'failed';
  sawOutput: boolean;
  taskStatus: PairedTaskStatus | null;
  outputSummary?: string | null;
}): PairedFollowUpQueueAction {
  if (
    args.executionStatus === 'failed' &&
    args.sawOutput === false &&
    (args.completedRole === 'reviewer' || args.completedRole === 'arbiter') &&
    isSilentCodexAccountFailure(args.outputSummary)
  ) {
    return 'none';
  }

  if (
    shouldRetrySilentOwnerExecution({
      completedRole: args.completedRole,
      executionStatus: args.executionStatus,
      sawOutput: args.sawOutput,
      taskStatus: args.taskStatus,
    })
  ) {
    return 'pending';
  }

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
