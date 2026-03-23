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
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./provider-fallback.js', () => ({
  detectFallbackTrigger: vi.fn(() => ({
    shouldFallback: false,
    reason: '',
  })),
  getActiveProvider: vi.fn(() => 'claude'),
  getFallbackEnvOverrides: vi.fn(() => ({})),
  getFallbackProviderName: vi.fn(() => 'fallback'),
  hasGroupProviderOverride: vi.fn(() => false),
  isFallbackEnabled: vi.fn(() => false),
  markPrimaryCooldown: vi.fn(),
}));

vi.mock('./session-recovery.js', () => ({
  shouldResetSessionOnAgentFailure: vi.fn(() => false),
}));

vi.mock('./memento-client.js', () => ({
  buildRoomMemoryBriefing: vi.fn(),
}));

import { runAgentProcess } from './agent-runner.js';
import { buildRoomMemoryBriefing } from './memento-client.js';
import { runAgentForGroup } from './message-agent-executor.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const deps = {
  assistantName: 'Andy',
  queue: {
    registerProcess: vi.fn(),
  },
  getRegisteredGroups: vi.fn(() => ({})),
  getSessions: vi.fn(() => ({})),
  persistSession: vi.fn(),
  clearSession: vi.fn(),
};

describe('runAgentForGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runAgentProcess).mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: 'session-123',
    });
    vi.mocked(buildRoomMemoryBriefing).mockResolvedValue(
      '## Shared Room Memory\n- remembered context',
    );
  });

  it('injects a room memory briefing when starting a fresh session', async () => {
    deps.getSessions.mockReturnValue({});

    const result = await runAgentForGroup(deps, {
      group: testGroup,
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-1',
    });

    expect(result).toBe('success');
    expect(buildRoomMemoryBriefing).toHaveBeenCalledWith({
      groupFolder: 'test-group',
      groupName: 'Test Group',
    });
    expect(runAgentProcess).toHaveBeenCalledWith(
      testGroup,
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
    deps.getSessions.mockReturnValue({ 'test-group': 'session-existing' });

    const result = await runAgentForGroup(deps, {
      group: testGroup,
      prompt: 'hello again',
      chatJid: 'group@test',
      runId: 'run-2',
    });

    expect(result).toBe('success');
    expect(buildRoomMemoryBriefing).not.toHaveBeenCalled();
    expect(runAgentProcess).toHaveBeenCalledWith(
      testGroup,
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
