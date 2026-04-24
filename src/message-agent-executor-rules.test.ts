import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-error-detection.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./agent-error-detection.js')>();
  return {
    ...actual,
    classifyRotationTrigger: vi.fn(() => ({
      shouldRetry: false,
      reason: '',
    })),
  };
});

vi.mock('./codex-token-rotation.js', () => ({
  detectCodexRotationTrigger: vi.fn(() => ({
    shouldRotate: false,
    reason: '',
  })),
}));

import { classifyRotationTrigger } from './agent-error-detection.js';
import { detectCodexRotationTrigger } from './codex-token-rotation.js';
import {
  isRetryableClaudeSessionFailureAttempt,
  resolveAttemptRetryAction,
  resolveClaudeRetryTrigger,
  resolveCodexRetryTrigger,
  resolvePairedFollowUpQueueAction,
} from './message-agent-executor-rules.js';

describe('message-agent-executor-rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a Claude retry trigger from streamed trigger state', () => {
    expect(
      resolveClaudeRetryTrigger({
        canRetryClaudeCredentials: true,
        provider: 'claude',
        attempt: {
          sawOutput: false,
          streamedTriggerReason: { reason: 'auth-expired', retryAfterMs: 5000 },
        },
      }),
    ).toEqual({
      reason: 'auth-expired',
      retryAfterMs: 5000,
    });
  });

  it('returns null for Claude retry when output was already visible', () => {
    expect(
      resolveClaudeRetryTrigger({
        canRetryClaudeCredentials: true,
        provider: 'claude',
        attempt: { sawOutput: true },
        fallbackMessage: '429 rate limit',
      }),
    ).toBeNull();
    expect(classifyRotationTrigger).not.toHaveBeenCalled();
  });

  it('resolves a Codex retry trigger from the codex detector', () => {
    vi.mocked(detectCodexRotationTrigger).mockReturnValue({
      shouldRotate: true,
      reason: 'auth-expired',
    });

    expect(
      resolveCodexRetryTrigger({
        canRetryCodex: true,
        attempt: {},
        rotationMessage: '401 oauth token has expired',
      }),
    ).toEqual({ reason: 'auth-expired' });
  });

  it('ignores streamed reasons that are not valid Codex rotation triggers', () => {
    expect(
      resolveCodexRetryTrigger({
        canRetryCodex: true,
        attempt: {
          streamedTriggerReason: { reason: 'usage-exhausted' },
        },
      }),
    ).toBeNull();
    expect(detectCodexRotationTrigger).not.toHaveBeenCalled();
  });

  it('resolves a shared Claude retry action from fallback output text', () => {
    vi.mocked(classifyRotationTrigger).mockReturnValue({
      shouldRetry: true,
      reason: '429',
      retryAfterMs: 30000,
    });

    expect(
      resolveAttemptRetryAction({
        provider: 'claude',
        canRetryClaudeCredentials: true,
        canRetryCodex: false,
        attempt: { sawOutput: false },
        rotationMessage: '429 rate limit',
      }),
    ).toEqual({
      kind: 'claude',
      trigger: { reason: '429', retryAfterMs: 30000 },
      rotationMessage: '429 rate limit',
    });
  });

  it('resolves a shared Codex retry action from streamed state', () => {
    expect(
      resolveAttemptRetryAction({
        provider: 'codex',
        canRetryClaudeCredentials: false,
        canRetryCodex: true,
        attempt: {
          sawOutput: false,
          streamedTriggerReason: { reason: 'auth-expired' },
        },
        rotationMessage: 'oauth token expired',
      }),
    ).toEqual({
      kind: 'codex',
      trigger: { reason: 'auth-expired' },
      rotationMessage: 'oauth token expired',
    });
  });

  it('detects retryable Claude session failures from either flag or classifier', () => {
    expect(
      isRetryableClaudeSessionFailureAttempt({
        attempt: {
          sawOutput: false,
          retryableSessionFailureDetected: true,
        },
        isClaudeCodeAgent: true,
        provider: 'claude',
        shouldRetryFreshSessionOnAgentFailure: vi.fn(() => false),
      }),
    ).toBe(true);

    const shouldRetryFreshSessionOnAgentFailure = vi.fn(() => true);
    expect(
      isRetryableClaudeSessionFailureAttempt({
        attempt: {
          sawOutput: false,
          error: new Error('stale session'),
        },
        isClaudeCodeAgent: true,
        provider: 'claude',
        shouldRetryFreshSessionOnAgentFailure,
      }),
    ).toBe(true);
    expect(shouldRetryFreshSessionOnAgentFailure).toHaveBeenCalledWith({
      result: null,
      error: 'stale session',
    });
  });

  it('resolves pending reviewer follow-up requeue from task state', () => {
    expect(
      resolvePairedFollowUpQueueAction({
        completedRole: 'reviewer',
        executionStatus: 'failed',
        sawOutput: false,
        taskStatus: 'review_ready',
      }),
    ).toBe('pending');
  });

  it('resolves pending arbiter follow-up requeue after repeated owner execution failures', () => {
    expect(
      resolvePairedFollowUpQueueAction({
        completedRole: 'owner',
        executionStatus: 'failed',
        sawOutput: false,
        taskStatus: 'arbiter_requested',
      }),
    ).toBe('pending');
  });

  it('does not request an executor-side follow-up after successful owner output moved the task to review_ready', () => {
    expect(
      resolvePairedFollowUpQueueAction({
        completedRole: 'owner',
        executionStatus: 'succeeded',
        sawOutput: true,
        taskStatus: 'review_ready',
      }),
    ).toBe('none');
  });

  it('does not request an executor-side follow-up when reviewer success moved the task to merge_ready', () => {
    expect(
      resolvePairedFollowUpQueueAction({
        completedRole: 'reviewer',
        executionStatus: 'succeeded',
        sawOutput: true,
        taskStatus: 'merge_ready',
      }),
    ).toBe('none');
  });

  it('does not request a generic follow-up after successful reviewer output moved the task back to active', () => {
    expect(
      resolvePairedFollowUpQueueAction({
        completedRole: 'reviewer',
        executionStatus: 'succeeded',
        sawOutput: true,
        taskStatus: 'active',
      }),
    ).toBe('none');
  });

  it('does not request a duplicate executor-side follow-up after successful owner STEP_DONE output', () => {
    expect(
      resolvePairedFollowUpQueueAction({
        completedRole: 'owner',
        executionStatus: 'succeeded',
        sawOutput: true,
        taskStatus: 'active',
        outputSummary: 'STEP_DONE\nkeep going',
      }),
    ).toBe('none');
  });

  it('returns none after successful output when no next-turn action is needed', () => {
    expect(
      resolvePairedFollowUpQueueAction({
        completedRole: 'owner',
        executionStatus: 'succeeded',
        sawOutput: true,
        taskStatus: 'active',
      }),
    ).toBe('none');
  });
});
