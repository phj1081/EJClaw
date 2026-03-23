import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-runner.js', () => ({
  runAgentProcess: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./available-groups.js', () => ({
  listAvailableGroups: vi.fn(() => []),
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/ejclaw-test-data',
}));

vi.mock('./db.js', () => ({
  getAllTasks: vi.fn(() => []),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./provider-fallback.js', () => ({
  detectFallbackTrigger: vi.fn((error?: string | null) => {
    const lower = (error || '').toLowerCase();
    if (
      lower.includes('429') ||
      lower.includes('rate limit') ||
      lower.includes('hit your limit')
    ) {
      return { shouldFallback: true, reason: '429' };
    }
    return { shouldFallback: false, reason: '' };
  }),
  getActiveProvider: vi.fn(async () => 'claude'),
  getFallbackEnvOverrides: vi.fn(() => ({
    ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
    ANTHROPIC_AUTH_TOKEN: 'test-kimi-key',
    ANTHROPIC_MODEL: 'kimi-k2.5',
  })),
  getFallbackProviderName: vi.fn(() => 'kimi'),
  hasGroupProviderOverride: vi.fn(() => false),
  isFallbackEnabled: vi.fn(() => true),
  markPrimaryCooldown: vi.fn(),
}));

vi.mock('./session-recovery.js', () => ({
  shouldResetSessionOnAgentFailure: vi.fn(() => false),
}));

vi.mock('./token-rotation.js', () => ({
  rotateToken: vi.fn(() => false),
  getTokenCount: vi.fn(() => 1),
  markTokenHealthy: vi.fn(),
}));

vi.mock('./codex-token-rotation.js', () => ({
  rotateCodexToken: vi.fn(() => false),
  getCodexAccountCount: vi.fn(() => 1),
  markCodexTokenHealthy: vi.fn(),
}));

vi.mock('./memento-client.js', () => ({
  buildRoomMemoryBriefing: vi.fn(),
}));

import * as agentRunner from './agent-runner.js';
import { buildRoomMemoryBriefing } from './memento-client.js';
import { runAgentForGroup } from './message-agent-executor.js';
import * as providerFallback from './provider-fallback.js';
import * as tokenRotation from './token-rotation.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-claude',
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    agentType: 'claude-code',
  };
}

function makeDeps() {
  return {
    assistantName: 'Andy',
    queue: {
      registerProcess: vi.fn(),
    },
    getRegisteredGroups: () => ({}),
    getSessions: () => ({}),
    persistSession: vi.fn(),
    clearSession: vi.fn(),
  };
}

describe('runAgentForGroup Claude rotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(providerFallback.getActiveProvider).mockResolvedValue('claude');
    vi.mocked(providerFallback.isFallbackEnabled).mockReturnValue(true);
    vi.mocked(providerFallback.hasGroupProviderOverride).mockReturnValue(false);
    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(1);
    vi.mocked(tokenRotation.rotateToken).mockReturnValue(false);
  });

  it('rotates to another Claude account before falling back to Kimi', async () => {
    const outputs: string[] = [];

    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(2);
    vi.mocked(tokenRotation.rotateToken).mockReturnValueOnce(true);

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'You’re out of extra usage · resets 4am (Asia/Seoul)',
        });
        return {
          status: 'success',
          result: null,
        };
      })
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '회전된 Claude 응답입니다.',
        });
        return {
          status: 'success',
          result: null,
        };
      });

    const result = await runAgentForGroup(makeDeps(), {
      group: makeGroup(),
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-rotate-claude',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(tokenRotation.rotateToken).toHaveBeenCalledTimes(1);
    expect(tokenRotation.markTokenHealthy).toHaveBeenCalledTimes(1);
    expect(providerFallback.markPrimaryCooldown).not.toHaveBeenCalled();
    expect(outputs).toEqual(['회전된 Claude 응답입니다.']);
  });

  it('falls back to Kimi only after all Claude accounts are exhausted', async () => {
    const outputs: string[] = [];

    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(2);
    vi.mocked(tokenRotation.rotateToken)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'You’re out of extra usage · resets 4am (Asia/Seoul)',
        });
        return {
          status: 'success',
          result: null,
        };
      })
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: "You're out of extra usage · resets 4am (Asia/Seoul)",
        });
        return {
          status: 'success',
          result: null,
        };
      })
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'Kimi 폴백 응답입니다.',
        });
        return {
          status: 'success',
          result: null,
        };
      });

    const result = await runAgentForGroup(makeDeps(), {
      group: makeGroup(),
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-fallback-after-rotation',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(3);
    expect(tokenRotation.rotateToken).toHaveBeenCalledTimes(2);
    expect(providerFallback.markPrimaryCooldown).toHaveBeenCalledWith(
      'usage-exhausted',
      undefined,
    );
    expect(agentRunner.runAgentProcess).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
        ANTHROPIC_MODEL: 'kimi-k2.5',
      }),
    );
    expect(outputs).toEqual(['Kimi 폴백 응답입니다.']);
  });

  it('does not mistake a normal response quoting the banner text for a usage error', async () => {
    const outputs: string[] = [];

    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(2);

    vi.mocked(agentRunner.runAgentProcess).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result:
            "상태 문구 예시: You're out of extra usage · resets 4am (Asia/Seoul) 라는 배너가 뜰 수 있습니다.",
        });
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const result = await runAgentForGroup(makeDeps(), {
      group: makeGroup(),
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-normal-quoted-banner',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('success');
    expect(tokenRotation.rotateToken).not.toHaveBeenCalled();
    expect(providerFallback.markPrimaryCooldown).not.toHaveBeenCalled();
    expect(outputs).toEqual([
      "상태 문구 예시: You're out of extra usage · resets 4am (Asia/Seoul) 라는 배너가 뜰 수 있습니다.",
    ]);
  });
});
