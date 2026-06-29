import { describe, expect, it, vi } from 'vitest';

import { executeMessageAgentAttemptLifecycle } from './message-agent-executor-lifecycle.js';
import type { MessageAgentAttempt } from './message-agent-executor-attempt-runner.js';

function makeAttempt(
  partial: Partial<MessageAgentAttempt>,
): MessageAgentAttempt {
  return {
    sawOutput: false,
    sawVisibleOutput: false,
    sawSuccessNullResultWithoutOutput: false,
    retryableSessionFailureDetected: false,
    resetSessionRequested: false,
    ...partial,
  };
}

describe('executeMessageAgentAttemptLifecycle', () => {
  it('clears a poisoned Claude resume session before transient same-account retry', async () => {
    let currentSessionId: string | undefined = 'poisoned-session';
    const sessionIdsSeenByAttempts: Array<string | undefined> = [];
    const clearStoredSession = vi.fn(() => {
      currentSessionId = undefined;
    });
    let attemptCount = 0;

    const result = await executeMessageAgentAttemptLifecycle({
      provider: 'claude',
      isClaudeCodeAgent: true,
      canRetryClaudeCredentials: true,
      clearStoredSession,
      clearRoleSdkSessions: vi.fn(),
      sessionFolder: 'cleanapo',
      maybeHandoffToCodex: vi.fn(() => false),
      hasDirectTerminalDelivery: () => false,
      pairedExecutionLifecycle: {
        markStatus: vi.fn(),
        markSawOutput: vi.fn(),
        updateSummary: vi.fn(),
        getSummary: () => null,
      },
      shouldRetryFreshSessionOnAgentFailure: () => false,
      rotationLogContext: {
        chatJid: 'room@test',
        group: 'CleanAPO',
        groupFolder: 'cleanapo',
        runId: 'run-network-retry',
      },
      log: {
        warn: vi.fn(),
        error: vi.fn(),
      },
      runAttempt: async () => {
        attemptCount += 1;
        sessionIdsSeenByAttempts.push(currentSessionId);
        if (attemptCount === 1) {
          return makeAttempt({
            output: {
              status: 'success',
              result:
                'Failed to authenticate. API Error: 401 The socket connection was closed unexpectedly.',
            },
            streamedTriggerReason: { reason: 'network-error' },
          });
        }

        return makeAttempt({
          output: { status: 'success', result: 'STEP_DONE' },
          sawOutput: true,
          sawVisibleOutput: true,
        });
      },
    });

    expect(result).toBe('success');
    expect(sessionIdsSeenByAttempts).toEqual(['poisoned-session', undefined]);
    expect(clearStoredSession).toHaveBeenCalledTimes(1);
  });
});
