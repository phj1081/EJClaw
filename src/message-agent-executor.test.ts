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
      lower.includes('does not have access to claude') ||
      (lower.includes('failed to authenticate') &&
        lower.includes('403') &&
        lower.includes('terminated'))
    ) {
      return { shouldFallback: true, reason: 'org-access-denied' };
    }
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
  isPrimaryNoFallbackCooldownActive: vi.fn(() => false),
  isUsageExhausted: vi.fn(() => false),
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
  detectCodexRotationTrigger: vi.fn((error?: string | null) => {
    const lower = (error || '').toLowerCase();
    if (
      lower.includes('429') ||
      lower.includes('rate limit') ||
      lower.includes('oauth token has expired') ||
      lower.includes('authentication_error') ||
      lower.includes('failed to authenticate') ||
      lower.includes('401')
    ) {
      return { shouldRotate: true, reason: 'auth-expired' };
    }
    return { shouldRotate: false, reason: '' };
  }),
  rotateCodexToken: vi.fn(() => false),
  getCodexAccountCount: vi.fn(() => 1),
  markCodexTokenHealthy: vi.fn(),
}));

vi.mock('./memento-client.js', () => ({
  buildRoomMemoryBriefing: vi.fn(),
}));

import * as agentRunner from './agent-runner.js';
import * as codexTokenRotation from './codex-token-rotation.js';
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

describe('runAgentForGroup room memory', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(providerFallback.getActiveProvider).mockResolvedValue('claude');
    vi.mocked(providerFallback.isFallbackEnabled).mockReturnValue(false);
    vi.mocked(providerFallback.hasGroupProviderOverride).mockReturnValue(false);
    vi.mocked(agentRunner.runAgentProcess).mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: 'session-123',
    });
    vi.mocked(buildRoomMemoryBriefing).mockResolvedValue(
      '## Shared Room Memory\n- remembered context',
    );
  });

  it('injects a room memory briefing when starting a fresh session', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    const deps = makeDeps();

    const result = await runAgentForGroup(deps, {
      group,
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-1',
    });

    expect(result).toBe('success');
    expect(buildRoomMemoryBriefing).toHaveBeenCalledWith({
      groupFolder: 'test-group',
      groupName: 'Test Group',
    });
    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        prompt: 'hello',
        sessionId: undefined,
        memoryBriefing: '## Shared Room Memory\n- remembered context',
      }),
      expect.any(Function),
      undefined,
      undefined,
    );
  });

  it('skips the room memory briefing for existing sessions', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    const deps = {
      ...makeDeps(),
      getSessions: () => ({ 'test-group': 'session-existing' }),
    };

    const result = await runAgentForGroup(deps, {
      group,
      prompt: 'hello again',
      chatJid: 'group@test',
      runId: 'run-2',
    });

    expect(result).toBe('success');
    expect(buildRoomMemoryBriefing).not.toHaveBeenCalled();
    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        prompt: 'hello again',
        sessionId: 'session-existing',
        memoryBriefing: undefined,
      }),
      expect.any(Function),
      undefined,
      undefined,
    );
  });
});

describe('runAgentForGroup Claude rotation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(buildRoomMemoryBriefing).mockResolvedValue(undefined);
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

  it('rotates to another Claude account when Claude streams an OAuth expiry banner', async () => {
    const outputs: string[] = [];

    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(2);
    vi.mocked(tokenRotation.rotateToken).mockReturnValueOnce(true);

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'intermediate',
          result:
            'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
        });
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result:
            'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
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
          result: '새 Claude 토큰 응답입니다.',
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
      runId: 'run-auth-expired-claude',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(tokenRotation.rotateToken).toHaveBeenCalledTimes(1);
    expect(tokenRotation.markTokenHealthy).toHaveBeenCalledTimes(1);
    expect(providerFallback.markPrimaryCooldown).not.toHaveBeenCalled();
    expect(outputs).toEqual(['새 Claude 토큰 응답입니다.']);
  });

  it('stops after all Claude accounts are usage-exhausted without falling back to Kimi', async () => {
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

    expect(result).toBe('error');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(tokenRotation.rotateToken).toHaveBeenCalledTimes(2);
    expect(providerFallback.markPrimaryCooldown).toHaveBeenCalledWith(
      'usage-exhausted',
      undefined,
    );
    expect(outputs).toEqual([]);
  });

  it('rotates to another Claude account when Claude streams an org access denied banner', async () => {
    const outputs: string[] = [];

    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(2);
    vi.mocked(tokenRotation.rotateToken).mockReturnValueOnce(true);

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'intermediate',
          result:
            'Your organization does not have access to Claude. Please login again or contact your administrator.',
        });
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result:
            'Your organization does not have access to Claude. Please login again or contact your administrator.',
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
          result: 'org access denied 회전 성공 응답',
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
      runId: 'run-org-access-denied-claude',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(tokenRotation.rotateToken).toHaveBeenCalledTimes(1);
    expect(tokenRotation.markTokenHealthy).toHaveBeenCalledTimes(1);
    expect(providerFallback.markPrimaryCooldown).not.toHaveBeenCalled();
    expect(outputs).toEqual(['org access denied 회전 성공 응답']);
  });

  it('stops after all Claude accounts are org-access-denied without falling back to Kimi', async () => {
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
          result:
            'Your organization does not have access to Claude. Please login again or contact your administrator.',
        });
        return {
          status: 'success',
          result: null,
        };
      })
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'error',
          result: null,
          error: 'Failed to authenticate. API Error: 403 terminated',
        });
        return {
          status: 'error',
          result: null,
          error: 'Failed to authenticate. API Error: 403 terminated',
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
      runId: 'run-org-access-denied-no-fallback',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('error');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(tokenRotation.rotateToken).toHaveBeenCalledTimes(2);
    expect(providerFallback.markPrimaryCooldown).toHaveBeenCalledWith(
      'org-access-denied',
      undefined,
    );
    expect(outputs).toEqual([]);
  });

  it('skips execution entirely when Claude no-fallback cooldown is already active', async () => {
    vi.mocked(providerFallback.getActiveProvider).mockResolvedValue('kimi');
    vi.mocked(
      providerFallback.isPrimaryNoFallbackCooldownActive,
    ).mockReturnValue(true);

    const result = await runAgentForGroup(makeDeps(), {
      group: makeGroup(),
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-skip-primary-cooldown',
    });

    expect(result).toBe('error');
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
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

describe('runAgentForGroup Codex rotation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(buildRoomMemoryBriefing).mockResolvedValue(undefined);
    vi.mocked(providerFallback.getActiveProvider).mockResolvedValue('claude');
    vi.mocked(providerFallback.isFallbackEnabled).mockReturnValue(false);
    vi.mocked(providerFallback.hasGroupProviderOverride).mockReturnValue(false);
    vi.mocked(codexTokenRotation.getCodexAccountCount).mockReturnValue(2);
    vi.mocked(codexTokenRotation.rotateCodexToken).mockReturnValueOnce(true);
  });

  it('retries Codex with a rotated account when OAuth auth expires', async () => {
    const codexGroup: RegisteredGroup = {
      ...makeGroup(),
      folder: 'test-codex',
      agentType: 'codex',
    };
    const outputs: string[] = [];

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'error',
          result: null,
          error:
            'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}',
        });
        return {
          status: 'error',
          result: null,
          error:
            'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}',
        };
      })
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '새 계정으로 재시도 성공',
          newSessionId: 'codex-thread-2',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'codex-thread-2',
        };
      });

    const result = await runAgentForGroup(makeDeps(), {
      group: codexGroup,
      prompt: 'hello codex',
      chatJid: 'group@test',
      runId: 'run-codex-auth-expired',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('success');
    expect(codexTokenRotation.rotateCodexToken).toHaveBeenCalledTimes(1);
    expect(codexTokenRotation.markCodexTokenHealthy).toHaveBeenCalledTimes(1);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(outputs).toEqual(['새 계정으로 재시도 성공']);
  });
});
