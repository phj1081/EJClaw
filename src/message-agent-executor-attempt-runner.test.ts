import { describe, expect, it, vi } from 'vitest';

const mockRunAgentProcess = vi.hoisted(() => vi.fn());

vi.mock('./agent-runner.js', () => ({
  runAgentProcess: mockRunAgentProcess,
}));

vi.mock('./codex-token-rotation.js', () => ({
  getCodexAccountCount: vi.fn(() => 2),
}));

import { runMessageAgentAttempt } from './message-agent-executor-attempt-runner.js';
import type { AgentOutput } from './agent-runner.js';

describe('runMessageAgentAttempt', () => {
  it('stores pre-stream Codex launch errors in paired summary', async () => {
    const error = new Error(
      'auth-expired: All Codex rotation accounts unavailable; re-auth required before launching Codex',
    );
    mockRunAgentProcess.mockRejectedValueOnce(error);
    const updateSummary = vi.fn();

    const attempt = await runMessageAgentAttempt({
      provider: 'codex',
      currentSessionId: undefined,
      isClaudeCodeAgent: false,
      canRetryClaudeCredentials: false,
      shouldPersistSession: false,
      effectiveGroup: {
        name: 'Test',
        folder: 'test',
        trigger: '@test',
        added_at: new Date().toISOString(),
        agentType: 'codex',
      },
      agentInput: {
        prompt: 'arbiter prompt',
        groupFolder: 'test',
        chatJid: 'dc:test',
        runId: 'run-test',
        isMain: false,
        assistantName: 'Andy',
      },
      activeRole: 'arbiter',
      effectiveServiceId: 'codex-review',
      effectiveAgentType: 'codex',
      sessionFolder: 'test:arbiter',
      onPersistSession: vi.fn(),
      registerProcess: vi.fn(),
      onOutput: vi.fn(async (_output: AgentOutput) => undefined),
      pairedExecutionLifecycle: {
        updateSummary,
        recordFinalOutputBeforeDelivery: vi.fn(() => false),
      },
      log: {
        child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any,
    });

    expect(attempt.error).toBe(error);
    expect(attempt.sawOutput).toBe(false);
    expect(updateSummary).toHaveBeenCalledWith({
      errorText:
        'auth-expired: All Codex rotation accounts unavailable; re-auth required before launching Codex',
    });
  });
});
