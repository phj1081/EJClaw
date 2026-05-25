import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/ejclaw-message-compact-refresh-test',
}));

vi.mock('./agent-runner.js', () => ({
  runAgentProcess: vi.fn(),
}));

vi.mock('./codex-token-rotation.js', () => ({
  getCodexAccountCount: vi.fn(() => 1),
}));

vi.mock('./session-recovery.js', () => ({
  shouldResetCodexSessionOnAgentFailure: vi.fn(() => false),
  shouldResetSessionOnAgentFailure: vi.fn(() => false),
  shouldRetryFreshCodexSessionOnAgentFailure: vi.fn(() => false),
}));

import { runAgentProcess, type AgentOutput } from './agent-runner.js';
import {
  maybeApplyCompactRefresh,
  readCompactRefreshFlag,
} from './compact-refresh.js';
import { runMessageAgentAttempt } from './message-agent-executor-attempt-runner.js';
import type { RegisteredGroup } from './types.js';

const dataDir = '/tmp/ejclaw-message-compact-refresh-test';

const group: RegisteredGroup = {
  name: 'Room',
  folder: 'room',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
  agentType: 'claude-code',
};

function makeLifecycle() {
  return {
    updateSummary: vi.fn(),
    recordFinalOutputBeforeDelivery: vi.fn(() => true),
  };
}

function makeLogger(): any {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

describe('message agent compact refresh', () => {
  beforeEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it('marks compacted owner sessions so the next turn gets one minimal refresh', async () => {
    const compactedOutput: AgentOutput = {
      status: 'success',
      result: 'done',
      output: { visibility: 'public', text: 'done' },
      newSessionId: 'session-1',
      compaction: { completed: true, trigger: 'auto' },
    };
    vi.mocked(runAgentProcess).mockResolvedValue(compactedOutput);

    await runMessageAgentAttempt({
      provider: 'claude',
      currentSessionId: 'session-1',
      isClaudeCodeAgent: true,
      canRetryClaudeCredentials: false,
      shouldPersistSession: true,
      effectiveGroup: group,
      agentInput: {
        prompt: 'work',
        sessionId: 'session-1',
        groupFolder: 'room',
        chatJid: 'room@test',
        runId: 'run-1',
        isMain: false,
        assistantName: 'Andy',
      },
      activeRole: 'owner',
      effectiveServiceId: 'claude',
      effectiveAgentType: 'claude-code',
      sessionFolder: 'room',
      onPersistSession: vi.fn(),
      registerProcess: vi.fn(),
      pairedExecutionLifecycle: makeLifecycle(),
      log: makeLogger(),
    });

    expect(readCompactRefreshFlag('room')).toMatchObject({
      sessionId: 'session-1',
      trigger: 'auto',
    });

    const applied = maybeApplyCompactRefresh({
      sessionFolder: 'room',
      sessionId: 'session-1',
      role: 'owner',
      prompt: 'next work',
    });
    expect(applied?.prompt).toContain('EJClaw compact refresh');
    expect(applied?.prompt).toContain('next work');
  });
});
