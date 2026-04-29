import type { VisibleVerdict } from './paired-verdict.js';

export type CompletionSignal =
  | { kind: 'request_reviewer'; resetStatusToActive: boolean }
  | { kind: 'request_owner_finalize' }
  | { kind: 'request_owner_changes' }
  | { kind: 'request_arbiter' }
  | { kind: 'complete'; completionReason: 'done' | 'escalated' }
  | { kind: 'preserve_review_ready' };

export function resolveOwnerCompletionSignal(args: {
  phase: 'normal' | 'finalize';
  visibleVerdict: VisibleVerdict;
  hasChangesSinceApproval?: boolean | null;
  roundTripCount?: number;
  deadlockThreshold?: number;
}): CompletionSignal {
  const {
    phase,
    visibleVerdict,
    hasChangesSinceApproval = false,
    roundTripCount = 0,
    deadlockThreshold = Number.POSITIVE_INFINITY,
  } = args;

  if (visibleVerdict === 'blocked' || visibleVerdict === 'needs_context') {
    return { kind: 'request_arbiter' };
  }

  if (phase === 'normal') {
    return {
      kind: 'request_reviewer',
      resetStatusToActive: false,
    };
  }

  if (visibleVerdict === 'step_done') {
    return {
      kind: 'request_reviewer',
      resetStatusToActive: true,
    };
  }

  const needsReReview =
    visibleVerdict === 'done_with_concerns' || hasChangesSinceApproval === true;

  if (needsReReview) {
    if (roundTripCount >= deadlockThreshold) {
      return { kind: 'request_arbiter' };
    }
    return {
      kind: 'request_reviewer',
      resetStatusToActive: true,
    };
  }

  return {
    kind: 'complete',
    completionReason: 'done',
  };
}

export function resolveReviewerCompletionSignal(args: {
  visibleVerdict: VisibleVerdict;
  roundTripCount: number;
  deadlockThreshold: number;
}): CompletionSignal {
  const { visibleVerdict, roundTripCount, deadlockThreshold } = args;

  switch (visibleVerdict) {
    case 'task_done':
    case 'done':
      return { kind: 'request_owner_finalize' };
    case 'step_done':
      if (roundTripCount >= deadlockThreshold) {
        return { kind: 'request_arbiter' };
      }
      return { kind: 'request_owner_changes' };
    case 'blocked':
    case 'needs_context':
      return { kind: 'request_arbiter' };
    case 'done_with_concerns':
    case 'continue':
    default:
      if (roundTripCount >= deadlockThreshold) {
        return { kind: 'request_arbiter' };
      }
      return { kind: 'request_owner_changes' };
  }
}

export function resolveReviewerFailureSignal(args: {
  visibleVerdict: VisibleVerdict;
}): CompletionSignal {
  const { visibleVerdict } = args;

  switch (visibleVerdict) {
    case 'task_done':
    case 'done':
      return { kind: 'request_owner_finalize' };
    case 'blocked':
    case 'needs_context':
      return {
        kind: 'complete',
        completionReason: 'escalated',
      };
    case 'done_with_concerns':
    case 'continue':
    default:
      return { kind: 'preserve_review_ready' };
  }
}
