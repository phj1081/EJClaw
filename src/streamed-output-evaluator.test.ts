import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AgentOutput } from './agent-runner.js';

// ── Mocks ──────────────────────────────────────────────────────
vi.mock('./agent-error-detection.js', () => ({
  classifyClaudeAuthError: vi.fn(() => ({ category: 'none', reason: '' })),
  classifyRotationTrigger: vi.fn(() => ({ shouldRetry: false, reason: '' })),
  detectClaudeProviderFailureMessage: vi.fn(() => ''),
  isClaudeUsageExhaustedMessage: vi.fn(() => false),
  isClaudeOrgAccessDeniedMessage: vi.fn(() => false),
  isClaudeAuthExpiredMessage: vi.fn(() => false),
  isClaudeAuthError: vi.fn(() => false),
}));

vi.mock('./codex-token-rotation.js', () => ({
  detectCodexRotationTrigger: vi.fn(() => ({
    shouldRotate: false,
    reason: '',
  })),
}));

vi.mock('./session-recovery.js', () => ({
  shouldRetryFreshCodexSessionOnAgentFailure: vi.fn(() => false),
  shouldRetryFreshSessionOnAgentFailure: vi.fn(() => false),
}));

import {
  classifyClaudeAuthError,
  classifyRotationTrigger,
  detectClaudeProviderFailureMessage,
  isClaudeUsageExhaustedMessage,
  isClaudeOrgAccessDeniedMessage,
  isClaudeAuthExpiredMessage,
  isClaudeAuthError,
} from './agent-error-detection.js';
import { detectCodexRotationTrigger } from './codex-token-rotation.js';
import {
  shouldRetryFreshCodexSessionOnAgentFailure,
  shouldRetryFreshSessionOnAgentFailure,
} from './session-recovery.js';

import {
  evaluateStreamedOutput,
  type StreamedOutputState,
  type EvaluateStreamedOutputOptions,
} from './streamed-output-evaluator.js';

// ── Helpers ────────────────────────────────────────────────────
function freshState(): StreamedOutputState {
  return {
    sawOutput: false,
    sawVisibleOutput: false,
    sawSuccessNullResultWithoutOutput: false,
  };
}

const claudeOpts: EvaluateStreamedOutputOptions = {
  agentType: 'claude-code',
  provider: 'claude',
};

const codexOpts: EvaluateStreamedOutputOptions = {
  agentType: 'codex',
  provider: 'codex',
};

function successOutput(
  result: string | null,
  phase?: AgentOutput['phase'],
): AgentOutput {
  return { status: 'success', result, ...(phase ? { phase } : {}) };
}

function errorOutput(error: string): AgentOutput {
  return { status: 'error', result: null, error };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(classifyClaudeAuthError).mockReturnValue({
    category: 'none',
    reason: '',
  });
  vi.mocked(classifyRotationTrigger).mockReturnValue({
    shouldRetry: false,
    reason: '',
  });
  vi.mocked(detectClaudeProviderFailureMessage).mockReturnValue('');
  vi.mocked(isClaudeUsageExhaustedMessage).mockReturnValue(false);
  vi.mocked(isClaudeOrgAccessDeniedMessage).mockReturnValue(false);
  vi.mocked(isClaudeAuthExpiredMessage).mockReturnValue(false);
  vi.mocked(isClaudeAuthError).mockReturnValue(false);
  vi.mocked(detectCodexRotationTrigger).mockReturnValue({
    shouldRotate: false,
    reason: '',
  });
  vi.mocked(shouldRetryFreshCodexSessionOnAgentFailure).mockReturnValue(false);
  vi.mocked(shouldRetryFreshSessionOnAgentFailure).mockReturnValue(false);
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

    it('does not set sawOutput for progress output', () => {
      const result = evaluateStreamedOutput(
        successOutput('대화 요약 중...', 'progress'),
        freshState(),
        claudeOpts,
      );
      expect(result.shouldForwardOutput).toBe(true);
      expect(result.state.sawOutput).toBe(false);
    });

    it('treats structured silent final output as output, not success-null-result', () => {
      const result = evaluateStreamedOutput(
        {
          status: 'success',
          result: null,
          output: { visibility: 'silent' },
        },
        freshState(),
        { ...claudeOpts, trackSuccessNullResult: true },
      );
      expect(result.shouldForwardOutput).toBe(true);
      expect(result.state.sawOutput).toBe(true);
      expect(result.state.sawSuccessNullResultWithoutOutput).toBe(false);
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

    it('detects a structured public usage-exhausted banner too', () => {
      vi.mocked(isClaudeUsageExhaustedMessage).mockReturnValue(true);

      const result = evaluateStreamedOutput(
        {
          status: 'success',
          result: null,
          output: {
            visibility: 'public',
            text: "You're out of extra usage. Resets at 5pm.",
          },
        },
        freshState(),
        claudeOpts,
      );
      expect(result.shouldForwardOutput).toBe(false);
      expect(result.newTrigger).toEqual({ reason: 'usage-exhausted' });
      expect(result.state.streamedTriggerReason).toEqual({
        reason: 'usage-exhausted',
      });
    });
  });

  describe('Claude retryable session failure suppression', () => {
    it('suppresses retryable session failures before any visible output', () => {
      vi.mocked(shouldRetryFreshSessionOnAgentFailure).mockReturnValue(true);

      const result = evaluateStreamedOutput(
        successOutput(
          'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.11.content.0: Invalid `signature` in `thinking` block"}}',
          'intermediate',
        ),
        freshState(),
        claudeOpts,
      );

      expect(result.shouldForwardOutput).toBe(false);
      expect(result.suppressedRetryableSessionFailure).toBe(true);
      expect(result.state.retryableSessionFailureDetected).toBe(true);
      expect(result.state.sawOutput).toBe(false);
    });

    it('does not suppress retryable session failures after visible output', () => {
      vi.mocked(shouldRetryFreshSessionOnAgentFailure).mockReturnValue(true);

      const result = evaluateStreamedOutput(
        successOutput('API Error: 400 invalid thinking block', 'final'),
        { ...freshState(), sawOutput: true },
        claudeOpts,
      );

      expect(result.shouldForwardOutput).toBe(true);
      expect(result.suppressedRetryableSessionFailure).toBeUndefined();
    });
  });

  describe('Codex retryable session failure suppression', () => {
    it('suppresses remote compact failures before any visible output', () => {
      vi.mocked(shouldRetryFreshCodexSessionOnAgentFailure).mockReturnValue(
        true,
      );

      const result = evaluateStreamedOutput(
        successOutput(
          "Error running remote compact task: Unknown parameter: 'prompt_cache_retention'",
          'intermediate',
        ),
        freshState(),
        codexOpts,
      );

      expect(result.shouldForwardOutput).toBe(false);
      expect(result.suppressedRetryableSessionFailure).toBe(true);
      expect(result.state.retryableSessionFailureDetected).toBe(true);
      expect(result.state.sawOutput).toBe(false);
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

  describe('Claude provider failure banner', () => {
    it('suppresses Cloudflare 502 HTML and returns newTrigger', () => {
      vi.mocked(detectClaudeProviderFailureMessage).mockReturnValue(
        'overloaded',
      );

      const result = evaluateStreamedOutput(
        successOutput(
          'API Error: 502 <html><center>cloudflare</center></html>',
        ),
        freshState(),
        claudeOpts,
      );
      expect(result.shouldForwardOutput).toBe(false);
      expect(result.newTrigger).toEqual({ reason: 'overloaded' });
      expect(result.state.streamedTriggerReason).toEqual({
        reason: 'overloaded',
      });
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

    it('suppresses a 403 terminated auth banner surfaced as success text', () => {
      vi.mocked(classifyClaudeAuthError).mockReturnValue({
        category: 'org-access-denied',
        reason: 'org-access-denied',
      });

      const result = evaluateStreamedOutput(
        successOutput('Failed to authenticate. API Error: 403 terminated'),
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

  describe('error → Claude rotation trigger', () => {
    it('returns rotation trigger with retryAfterMs', () => {
      vi.mocked(classifyRotationTrigger).mockReturnValue({
        shouldRetry: true,
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
      vi.mocked(classifyRotationTrigger).mockReturnValue({
        shouldRetry: true,
        reason: '429',
      });

      const result = evaluateStreamedOutput(errorOutput('429'), freshState(), {
        ...claudeOpts,
        shortCircuitTriggeredErrors: true,
      });
      expect(result.shouldForwardOutput).toBe(false);
      expect(result.newTrigger).toEqual({ reason: '429' });
    });

    it('skips rotation check when output was already seen', () => {
      vi.mocked(classifyRotationTrigger).mockReturnValue({
        shouldRetry: true,
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

    it('skips rotation check when already triggered', () => {
      vi.mocked(classifyRotationTrigger).mockReturnValue({
        shouldRetry: true,
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

      evaluateStreamedOutput(errorOutput('429'), freshState(), claudeOpts);
      // Claude uses classifyRotationTrigger, not detectCodexRotationTrigger
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
