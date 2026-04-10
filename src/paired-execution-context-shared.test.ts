import { describe, expect, it } from 'vitest';

import {
  hasRecognizedPairedTerminalSummary,
  parseVisibleVerdict,
  resolveOwnerCompletionSignal,
  resolveReviewerCompletionSignal,
  resolveReviewerFailureSignal,
} from './paired-execution-context-shared.js';

describe('paired execution context shared verdict helpers', () => {
  it('parses visible verdicts from the first summary line only', () => {
    expect(
      parseVisibleVerdict(
        'DONE_WITH_CONCERNS\n\nfollow-up detail that should not affect parsing',
      ),
    ).toBe('done_with_concerns');
    expect(parseVisibleVerdict('BLOCKED\nextra detail')).toBe('blocked');
    expect(parseVisibleVerdict('random prose')).toBe('continue');
  });

  it('recognizes paired terminal summaries only when the role-specific verdict is explicit', () => {
    expect(
      hasRecognizedPairedTerminalSummary('owner', 'plain owner update'),
    ).toBe(true);
    expect(
      hasRecognizedPairedTerminalSummary(
        'reviewer',
        'DONE_WITH_CONCERNS\nfollow-up detail',
      ),
    ).toBe(true);
    expect(
      hasRecognizedPairedTerminalSummary(
        'reviewer',
        '요청 범위를 실제로 지워졌는지 확인하겠습니다.',
      ),
    ).toBe(false);
    expect(
      hasRecognizedPairedTerminalSummary('arbiter', 'PROCEED\n승인합니다.'),
    ).toBe(true);
    expect(
      hasRecognizedPairedTerminalSummary(
        'arbiter',
        '대화와 현재 코드 상태를 대조해 먼저 확인하겠습니다.',
      ),
    ).toBe(false);
  });

  it('maps normal owner completion verdicts to reviewer or arbiter signals', () => {
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
