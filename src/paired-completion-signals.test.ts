import { describe, expect, it } from 'vitest';

import {
  resolveOwnerCompletionSignal,
  resolveReviewerCompletionSignal,
  resolveReviewerFailureSignal,
} from './paired-completion-signals.js';

describe('paired completion signals', () => {
  it('maps normal owner completion verdicts to reviewer or arbiter signals', () => {
    expect(
      resolveOwnerCompletionSignal({
        phase: 'normal',
        visibleVerdict: 'step_done',
      }),
    ).toEqual({
      kind: 'request_reviewer',
      resetStatusToActive: false,
    });
    expect(
      resolveOwnerCompletionSignal({
        phase: 'normal',
        visibleVerdict: 'done',
      }),
    ).toEqual({
      kind: 'request_reviewer',
      resetStatusToActive: false,
    });
    expect(
      resolveOwnerCompletionSignal({
        phase: 'normal',
        visibleVerdict: 'blocked',
      }),
    ).toEqual({ kind: 'request_arbiter' });
  });

  it('maps finalize owner outcomes to complete, re-review, or arbiter', () => {
    expect(
      resolveOwnerCompletionSignal({
        phase: 'finalize',
        visibleVerdict: 'step_done',
        hasChangesSinceApproval: false,
        roundTripCount: 0,
        deadlockThreshold: 2,
      }),
    ).toEqual({
      kind: 'request_reviewer',
      resetStatusToActive: true,
    });
    expect(
      resolveOwnerCompletionSignal({
        phase: 'finalize',
        visibleVerdict: 'done',
        hasChangesSinceApproval: false,
        roundTripCount: 0,
        deadlockThreshold: 2,
      }),
    ).toEqual({ kind: 'complete', completionReason: 'done' });
    expect(
      resolveOwnerCompletionSignal({
        phase: 'finalize',
        visibleVerdict: 'done_with_concerns',
        hasChangesSinceApproval: false,
        roundTripCount: 1,
        deadlockThreshold: 3,
      }),
    ).toEqual({
      kind: 'request_reviewer',
      resetStatusToActive: true,
    });
    expect(
      resolveOwnerCompletionSignal({
        phase: 'finalize',
        visibleVerdict: 'done',
        hasChangesSinceApproval: true,
        roundTripCount: 3,
        deadlockThreshold: 3,
      }),
    ).toEqual({ kind: 'request_arbiter' });
  });

  it('maps reviewer completion verdicts to finalize, owner changes, or arbiter', () => {
    expect(
      resolveReviewerCompletionSignal({
        visibleVerdict: 'task_done',
        roundTripCount: 0,
        deadlockThreshold: 3,
      }),
    ).toEqual({ kind: 'request_owner_finalize' });
    expect(
      resolveReviewerCompletionSignal({
        visibleVerdict: 'step_done',
        roundTripCount: 0,
        deadlockThreshold: 3,
      }),
    ).toEqual({ kind: 'request_owner_changes' });
    expect(
      resolveReviewerCompletionSignal({
        visibleVerdict: 'step_done',
        roundTripCount: 3,
        deadlockThreshold: 3,
      }),
    ).toEqual({ kind: 'request_arbiter' });
    expect(
      resolveReviewerCompletionSignal({
        visibleVerdict: 'done',
        roundTripCount: 0,
        deadlockThreshold: 3,
      }),
    ).toEqual({ kind: 'request_owner_finalize' });
    expect(
      resolveReviewerCompletionSignal({
        visibleVerdict: 'continue',
        roundTripCount: 1,
        deadlockThreshold: 3,
      }),
    ).toEqual({ kind: 'request_owner_changes' });
    expect(
      resolveReviewerCompletionSignal({
        visibleVerdict: 'done_with_concerns',
        roundTripCount: 3,
        deadlockThreshold: 3,
      }),
    ).toEqual({ kind: 'request_arbiter' });
  });

  it('maps reviewer failure verdicts to explicit failure signals', () => {
    expect(
      resolveReviewerFailureSignal({
        visibleVerdict: 'task_done',
      }),
    ).toEqual({ kind: 'request_owner_finalize' });
    expect(
      resolveReviewerFailureSignal({
        visibleVerdict: 'done',
      }),
    ).toEqual({ kind: 'request_owner_finalize' });
    expect(
      resolveReviewerFailureSignal({
        visibleVerdict: 'needs_context',
      }),
    ).toEqual({ kind: 'complete', completionReason: 'escalated' });
    expect(
      resolveReviewerFailureSignal({
        visibleVerdict: 'continue',
      }),
    ).toEqual({ kind: 'preserve_review_ready' });
  });
});
