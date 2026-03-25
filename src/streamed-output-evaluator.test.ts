import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AgentOutput } from './agent-runner.js';

// ── Mocks ──────────────────────────────────────────────────────
vi.mock('./agent-error-detection.js', () => ({
  isClaudeUsageExhaustedMessage: vi.fn(() => false),
  isClaudeOrgAccessDeniedMessage: vi.fn(() => false),
  isClaudeAuthExpiredMessage: vi.fn(() => false),
  isClaudeAuthError: vi.fn(() => false),
}));

vi.mock('./provider-fallback.js', () => ({
  detectFallbackTrigger: vi.fn(() => ({ shouldFallback: false, reason: '' })),
}));

vi.mock('./codex-token-rotation.js', () => ({
  detectCodexRotationTrigger: vi.fn(() => ({
    shouldRotate: false,
    reason: '',
  })),
}));

import {
  isClaudeUsageExhaustedMessage,
  isClaudeOrgAccessDeniedMessage,
  isClaudeAuthExpiredMessage,
  isClaudeAuthError,
} from './agent-error-detection.js';
import { detectFallbackTrigger } from './provider-fallback.js';
import { detectCodexRotationTrigger } from './codex-token-rotation.js';

import {
  evaluateStreamedOutput,
  type StreamedOutputState,
  type EvaluateStreamedOutputOptions,
} from './streamed-output-evaluator.js';

// ── Helpers ────────────────────────────────────────────────────
function freshState(): StreamedOutputState {
  return { sawOutput: false, sawSuccessNullResultWithoutOutput: false };
}

const claudeOpts: EvaluateStreamedOutputOptions = {
  agentType: 'claude-code',
  provider: 'claude',
};

const codexOpts: EvaluateStreamedOutputOptions = {
  agentType: 'codex',
  provider: 'codex',
};

function successOutput(result: string | null): AgentOutput {
  return { status: 'success', result };
}

function errorOutput(error: string): AgentOutput {
  return { status: 'error', result: null, error };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isClaudeUsageExhaustedMessage).mockReturnValue(false);
  vi.mocked(isClaudeOrgAccessDeniedMessage).mockReturnValue(false);
  vi.mocked(isClaudeAuthExpiredMessage).mockReturnValue(false);
  vi.mocked(isClaudeAuthError).mockReturnValue(false);
  vi.mocked(detectFallbackTrigger).mockReturnValue({
    shouldFallback: false,
    reason: '',
  });
  vi.mocked(detectCodexRotationTrigger).mockReturnValue({
    shouldRotate: false,
    reason: '',
  });
});

// ── Tests ──────────────────────────────────────────────────────

describe('evaluateStreamedOutput', () => {
  describe('normal output forwarding', () => {
    it('forwards success output and sets sawOutput', () => {
      const result = evaluateStreamedOutput(
        successOutput('Hello'),
        freshState(),
        claudeOpts,
      );
      expect(result.shouldForwardOutput).toBe(true);
      expect(result.state.sawOutput).toBe(true);
      expect(result.newTrigger).toBeUndefined();
    });

    it('forwards output for non-primary agent type', () => {
      const result = evaluateStreamedOutput(
        successOutput('Hello'),
        freshState(),
        { agentType: 'claude-code', provider: 'fallback' },
      );
      expect(result.shouldForwardOutput).toBe(true);
      expect(result.state.sawOutput).toBe(true);
    });

    it('does not set sawOutput for null result', () => {
      const result = evaluateStreamedOutput(
        successOutput(null),
        freshState(),
        claudeOpts,
      );
      expect(result.shouldForwardOutput).toBe(true);
      expect(result.state.sawOutput).toBe(false);
    });
  });

  describe('Claude usage-exhausted banner', () => {
    it('suppresses output and returns newTrigger', () => {
      vi.mocked(isClaudeUsageExhaustedMessage).mockReturnValue(true);

      const result = evaluateStreamedOutput(
        successOutput("You're out of extra usage. Resets at 5pm."),
        freshState(),
        claudeOpts,
      );
      expect(result.shouldForwardOutput).toBe(false);
      expect(result.newTrigger).toEqual({ reason: 'usage-exhausted' });
      expect(result.state.streamedTriggerReason).toEqual({
        reason: 'usage-exhausted',
      });
    });

    it('does not fire on non-primary Claude', () => {
      vi.mocked(isClaudeUsageExhaustedMessage).mockReturnValue(true);

      const result = evaluateStreamedOutput(
        successOutput('banner text'),
        freshState(),
        { agentType: 'claude-code', provider: 'fallback' },
      );
      // Non-primary: skip banner check, forward normally
      expect(result.shouldForwardOutput).toBe(true);
      expect(result.newTrigger).toBeUndefined();
    });

    it('does not fire when output was already seen', () => {
      vi.mocked(isClaudeUsageExhaustedMessage).mockReturnValue(true);

      const result = evaluateStreamedOutput(
        successOutput('banner text'),
        { ...freshState(), sawOutput: true },
        claudeOpts,
      );
      expect(result.shouldForwardOutput).toBe(true);
      expect(result.newTrigger).toBeUndefined();
    });
  });

  describe('Claude auth-expired banner', () => {
    it('suppresses output and returns newTrigger', () => {
      vi.mocked(isClaudeAuthExpiredMessage).mockReturnValue(true);

      const result = evaluateStreamedOutput(
        successOutput('Failed to authenticate...'),
        freshState(),
        claudeOpts,
      );
      expect(result.shouldForwardOutput).toBe(false);
      expect(result.newTrigger).toEqual({ reason: 'auth-expired' });
    });
  });

  describe('Claude org-access-denied banner', () => {
    it('suppresses output and returns newTrigger', () => {
      vi.mocked(isClaudeOrgAccessDeniedMessage).mockReturnValue(true);

      const result = evaluateStreamedOutput(
        successOutput(
          'Your organization does not have access to Claude. Please login again or contact your administrator.',
        ),
        freshState(),
        claudeOpts,
      );
      expect(result.shouldForwardOutput).toBe(false);
      expect(result.newTrigger).toEqual({ reason: 'org-access-denied' });
      expect(result.state.streamedTriggerReason).toEqual({
        reason: 'org-access-denied',
      });
    });
  });

  describe('duplicate trigger suppression', () => {
    it('suppresses output but returns no newTrigger when already triggered', () => {
      vi.mocked(isClaudeUsageExhaustedMessage).mockReturnValue(true);

      const stateWithTrigger: StreamedOutputState = {
        ...freshState(),
        streamedTriggerReason: { reason: 'usage-exhausted' },
      };
      const result = evaluateStreamedOutput(
        successOutput('second banner'),
        stateWithTrigger,
        claudeOpts,
      );
      expect(result.shouldForwardOutput).toBe(false);
      expect(result.newTrigger).toBeUndefined();
      // Existing trigger preserved
      expect(result.state.streamedTriggerReason).toEqual({
        reason: 'usage-exhausted',
      });
    });
  });

  describe('Claude auth error suppression', () => {
    it('suppresses auth error output when option enabled', () => {
      vi.mocked(isClaudeAuthError).mockReturnValue(true);

      const result = evaluateStreamedOutput(
        successOutput('Failed to authenticate 401 authentication_error'),
        freshState(),
        { ...claudeOpts, suppressClaudeAuthErrorOutput: true },
      );
      expect(result.shouldForwardOutput).toBe(false);
      expect(result.suppressedAuthError).toBe(true);
      expect(result.newTrigger).toBeUndefined();
    });

    it('forwards auth error output when option not enabled', () => {
      vi.mocked(isClaudeAuthError).mockReturnValue(true);

      const result = evaluateStreamedOutput(
        successOutput('Failed to authenticate 401 authentication_error'),
        freshState(),
        claudeOpts,
      );
      // No suppressClaudeAuthErrorOutput — forwarded normally
      expect(result.shouldForwardOutput).toBe(true);
      expect(result.suppressedAuthError).toBeUndefined();
    });
  });

  describe('success null result tracking', () => {
    it('tracks success-null-result on primary Claude when option enabled', () => {
      const result = evaluateStreamedOutput(successOutput(null), freshState(), {
        ...claudeOpts,
        trackSuccessNullResult: true,
      });
      expect(result.state.sawSuccessNullResultWithoutOutput).toBe(true);
      expect(result.shouldForwardOutput).toBe(true);
    });

    it('does not track when sawOutput is already true', () => {
      const result = evaluateStreamedOutput(
        successOutput(null),
        { ...freshState(), sawOutput: true },
        { ...claudeOpts, trackSuccessNullResult: true },
      );
      expect(result.state.sawSuccessNullResultWithoutOutput).toBe(false);
    });

    it('does not track when option is disabled', () => {
      const result = evaluateStreamedOutput(
        successOutput(null),
        freshState(),
        claudeOpts,
      );
      expect(result.state.sawSuccessNullResultWithoutOutput).toBe(false);
    });

    it('does not track for non-primary Claude', () => {
      const result = evaluateStreamedOutput(successOutput(null), freshState(), {
        agentType: 'claude-code',
        provider: 'fallback',
        trackSuccessNullResult: true,
      });
      expect(result.state.sawSuccessNullResultWithoutOutput).toBe(false);
    });
  });

  describe('error → Claude fallback trigger', () => {
    it('returns fallback trigger with retryAfterMs', () => {
      vi.mocked(detectFallbackTrigger).mockReturnValue({
        shouldFallback: true,
        reason: '429',
        retryAfterMs: 30000,
      });

      const result = evaluateStreamedOutput(
        errorOutput('429 Too Many Requests'),
        freshState(),
        claudeOpts,
      );
      expect(result.newTrigger).toEqual({
        reason: '429',
        retryAfterMs: 30000,
      });
      expect(result.state.streamedTriggerReason).toEqual({
        reason: '429',
        retryAfterMs: 30000,
      });
      // Without shortCircuit, error is still forwarded
      expect(result.shouldForwardOutput).toBe(true);
    });

    it('suppresses error forward when shortCircuitTriggeredErrors is set', () => {
      vi.mocked(detectFallbackTrigger).mockReturnValue({
        shouldFallback: true,
        reason: '429',
      });

      const result = evaluateStreamedOutput(errorOutput('429'), freshState(), {
        ...claudeOpts,
        shortCircuitTriggeredErrors: true,
      });
      expect(result.shouldForwardOutput).toBe(false);
      expect(result.newTrigger).toEqual({ reason: '429' });
    });

    it('skips fallback check when output was already seen', () => {
      vi.mocked(detectFallbackTrigger).mockReturnValue({
        shouldFallback: true,
        reason: '429',
      });

      const result = evaluateStreamedOutput(
        errorOutput('429'),
        { ...freshState(), sawOutput: true },
        claudeOpts,
      );
      expect(result.newTrigger).toBeUndefined();
      expect(result.shouldForwardOutput).toBe(true);
    });

    it('skips fallback check when already triggered', () => {
      vi.mocked(detectFallbackTrigger).mockReturnValue({
        shouldFallback: true,
        reason: '429',
      });

      const result = evaluateStreamedOutput(
        errorOutput('429'),
        {
          ...freshState(),
          streamedTriggerReason: { reason: 'usage-exhausted' },
        },
        claudeOpts,
      );
      expect(result.newTrigger).toBeUndefined();
    });
  });

  describe('error → Codex rotation trigger', () => {
    it('returns rotation trigger for Codex primary', () => {
      vi.mocked(detectCodexRotationTrigger).mockReturnValue({
        shouldRotate: true,
        reason: '429',
      });

      const result = evaluateStreamedOutput(
        errorOutput('429 rate limit'),
        freshState(),
        codexOpts,
      );
      expect(result.newTrigger).toEqual({ reason: '429' });
      expect(result.state.streamedTriggerReason).toEqual({ reason: '429' });
    });

    it('does not check Codex rotation for Claude agent type', () => {
      vi.mocked(detectCodexRotationTrigger).mockReturnValue({
        shouldRotate: true,
        reason: '429',
      });

      const result = evaluateStreamedOutput(
        errorOutput('429'),
        freshState(),
        claudeOpts,
      );
      // Claude uses detectFallbackTrigger, not detectCodexRotationTrigger
      expect(detectCodexRotationTrigger).not.toHaveBeenCalled();
    });
  });

  describe('error without trigger match', () => {
    it('forwards error normally when no trigger matches', () => {
      const result = evaluateStreamedOutput(
        errorOutput('some random error'),
        freshState(),
        claudeOpts,
      );
      expect(result.shouldForwardOutput).toBe(true);
      expect(result.newTrigger).toBeUndefined();
    });
  });

  describe('state immutability', () => {
    it('does not mutate the input state object', () => {
      const inputState = freshState();
      const frozen = { ...inputState };

      evaluateStreamedOutput(successOutput('Hello'), inputState, claudeOpts);

      expect(inputState).toEqual(frozen);
    });
  });
});
