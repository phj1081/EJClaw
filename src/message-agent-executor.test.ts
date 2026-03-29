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
  CODEX_MAIN_SERVICE_ID: 'codex-main',
  CODEX_REVIEW_SERVICE_ID: 'codex-review',
  DATA_DIR: '/tmp/ejclaw-test-data',
  REVIEWER_AGENT_TYPE: 'claude-code',
  SERVICE_SESSION_SCOPE: 'claude',
  isClaudeService: vi.fn(() => true),
  normalizeServiceId: vi.fn((serviceId: string) =>
    serviceId === 'codex' ? 'codex-main' : serviceId,
  ),
}));

vi.mock('./db.js', () => ({
  createServiceHandoff: vi.fn(),
  getAllTasks: vi.fn(() => []),
  getLatestOpenPairedTaskForChat: vi.fn(() => undefined),
}));

vi.mock('./service-routing.js', () => ({
  activateCodexFailover: vi.fn(),
  getEffectiveChannelLease: vi.fn(() => ({
    chat_jid: 'group@test',
    owner_service_id: 'claude',
    reviewer_service_id: 'codex-main',
    activated_at: null,
    reason: null,
    explicit: false,
  })),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./agent-error-detection.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./agent-error-detection.js')>();
  return {
    ...actual,
    classifyRotationTrigger: vi.fn((error?: string | null) => {
      const lower = (error || '').toLowerCase();
      if (
        lower.includes('does not have access to claude') ||
        (lower.includes('failed to authenticate') &&
          lower.includes('403') &&
          lower.includes('terminated'))
      ) {
        return { shouldRetry: true, reason: 'org-access-denied' };
      }
      if (
        lower.includes('429') ||
        lower.includes('rate limit') ||
        lower.includes('hit your limit')
      ) {
        return { shouldRetry: true, reason: '429' };
      }
      return { shouldRetry: false, reason: '' };
    }),
  };
});

vi.mock('./session-recovery.js', () => ({
  shouldResetSessionOnAgentFailure: vi.fn(() => false),
  shouldRetryFreshSessionOnAgentFailure: vi.fn(() => false),
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

vi.mock('./paired-execution-context.js', () => ({
  completePairedExecutionContext: vi.fn(),
  preparePairedExecutionContext: vi.fn(() => undefined),
}));

import * as agentRunner from './agent-runner.js';
import type { AgentOutput } from './agent-runner.js';
import * as codexTokenRotation from './codex-token-rotation.js';
import * as db from './db.js';
import { buildRoomMemoryBriefing } from './memento-client.js';
import { runAgentForGroup } from './message-agent-executor.js';
import * as pairedExecutionContext from './paired-execution-context.js';
import * as sessionRecovery from './session-recovery.js';
import * as serviceRouting from './service-routing.js';
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
      enqueueMessageCheck: vi.fn(),
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
        prompt: expect.stringContaining('hello'),
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
        prompt: expect.stringContaining('hello again'),
        sessionId: 'session-existing',
        memoryBriefing: undefined,
      }),
      expect.any(Function),
      undefined,
      undefined,
    );
  });

  it('passes the prompt through unchanged', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };

    await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-suppress',
    });

    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        prompt: 'hello',
      }),
      expect.any(Function),
      undefined,
      undefined,
    );
  });

  it('passes paired-room role metadata through to the runner input', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };

    await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-room-role',
    });

    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        roomRoleContext: {
          serviceId: 'claude',
          role: 'owner',
          ownerServiceId: 'claude',
          reviewerServiceId: 'codex-main',
          failoverOwner: false,
        },
      }),
      expect.any(Function),
      undefined,
      undefined,
    );
  });

  it('keeps the reviewer prompt unchanged when the current service is the reviewer for the chat', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_service_id: 'claude',
      reviewer_service_id: 'claude',
      activated_at: null,
      reason: null,
      explicit: false,
    });

    await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-review-suppress',
    });

    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        prompt: 'hello',
      }),
      expect.any(Function),
      undefined,
      undefined,
    );
  });

  it('allows silent reviewer outputs', async () => {
    const group = { ...makeGroup(), folder: 'test-group', workDir: '/repo' };
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      activated_at: null,
      reason: null,
      explicit: false,
    });
    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-gate',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'codex-main',
        reviewer_service_id: 'claude',
        title: null,
        source_ref: 'HEAD',
        review_requested_at: null,
        plan_notes: null,
        round_trip_count: 0,
        status: 'active',
        created_at: '2026-03-29T00:00:00.000Z',
        updated_at: '2026-03-29T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {},
    });
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: null,
          output: { visibility: 'silent' },
          phase: 'final',
        });
        return {
          status: 'success',
          result: null,
        };
      },
    );
    const outputs: AgentOutput[] = [];

    const result = await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-review-silent',
      onOutput: async (output) => {
        outputs.push(output);
      },
    });

    expect(result).toBe('success');
    expect(outputs).toEqual([
      expect.objectContaining({
        output: { visibility: 'silent' },
      }),
    ]);
  });

  it('passes paired workspace env overrides into the runner when execution metadata exists', async () => {
    const group = {
      ...makeGroup(),
      folder: 'test-group',
      workDir: '/repo/canonical',
    };

    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-1',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'claude',
        reviewer_service_id: 'codex-main',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        round_trip_count: 0,
        review_requested_at: null,
        status: 'active',
        created_at: '2026-03-28T00:00:00.000Z',
        updated_at: '2026-03-28T00:00:00.000Z',
      },
      workspace: {
        id: 'paired-task-1:owner',
        task_id: 'paired-task-1',
        role: 'owner',
        workspace_dir: '/tmp/paired/owner',
        snapshot_source_dir: null,
        snapshot_ref: null,
        status: 'ready',
        snapshot_refreshed_at: null,
        created_at: '2026-03-28T00:00:00.000Z',
        updated_at: '2026-03-28T00:00:00.000Z',
      },
      envOverrides: {
        EJCLAW_WORK_DIR: '/tmp/paired/owner',
        EJCLAW_PAIRED_TASK_ID: 'paired-task-1',
        EJCLAW_PAIRED_ROLE: 'owner',
      },
    });

    await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-room-role',
    });

    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        roomRoleContext: expect.any(Object),
      }),
      expect.any(Function),
      undefined,
      expect.objectContaining({
        EJCLAW_WORK_DIR: '/tmp/paired/owner',
        EJCLAW_PAIRED_TASK_ID: 'paired-task-1',
        EJCLAW_PAIRED_ROLE: 'owner',
      }),
    );
    expect(
      pairedExecutionContext.completePairedExecutionContext,
    ).toHaveBeenCalledWith({
      taskId: 'paired-task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'ok',
    });
  });

  it('blocks reviewer execution when an in-review snapshot became stale and does not spawn the runner', async () => {
    const group = {
      ...makeGroup(),
      folder: 'test-group',
      workDir: '/repo/canonical',
    };
    const outputs: Array<{ text?: string; result?: string | null }> = [];

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      activated_at: null,
      reason: null,
      explicit: false,
    });
    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-1',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'codex-main',
        reviewer_service_id: 'claude',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        round_trip_count: 0,
        review_requested_at: null,
        status: 'active',
        created_at: '2026-03-28T00:00:00.000Z',
        updated_at: '2026-03-28T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {
        EJCLAW_PAIRED_TASK_ID: 'paired-task-1',
        EJCLAW_PAIRED_ROLE: 'reviewer',
        EJCLAW_REVIEWER_RUNTIME: '1',
      },
      blockMessage:
        'Review snapshot is stale after owner changes. Retry the review once to refresh against the latest owner workspace.',
    });

    const result = await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-blocked-reviewer',
      onOutput: async (output) => {
        outputs.push({
          text:
            output.output && 'text' in output.output
              ? output.output.text
              : undefined,
          result: output.result,
        });
      },
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(outputs).toEqual([
      {
        text: 'Review snapshot is stale after owner changes. Retry the review once to refresh against the latest owner workspace.',
        result: null,
      },
    ]);
    expect(
      pairedExecutionContext.completePairedExecutionContext,
    ).toHaveBeenCalledWith({
      taskId: 'paired-task-1',
      role: 'owner',
      status: 'failed',
      summary:
        'Review snapshot is stale after owner changes. Retry the review once to refresh against the latest owner workspace.',
    });
  });
});

describe('runAgentForGroup Claude rotation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(buildRoomMemoryBriefing).mockResolvedValue(undefined);
    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(1);
    vi.mocked(tokenRotation.rotateToken).mockReturnValue(false);
  });

  it('rotates to another Claude account on usage exhaustion', async () => {
    const outputs: string[] = [];

    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(2);
    vi.mocked(tokenRotation.rotateToken).mockReturnValueOnce(true);

    vi.mocked(agentRunner.runAgentProcess)
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
    // No fallback provider — rotation is the only recovery mechanism
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
    // No fallback provider — rotation is the only recovery mechanism
    expect(outputs).toEqual(['새 Claude 토큰 응답입니다.']);
  });

  it('suppresses Claude 502 HTML and returns error when no rotation is available', async () => {
    const outputs: string[] = [];

    vi.mocked(agentRunner.runAgentProcess).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'intermediate',
          result:
            'API Error: 502 <html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>cloudflare</center></body></html>',
        });
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result:
            'API Error: 502 <html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>cloudflare</center></body></html>',
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
      runId: 'run-claude-502-error',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('error');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(outputs).toEqual([]);
    expect(db.createServiceHandoff).not.toHaveBeenCalled();
  });

  it('clears the Claude session and retries fresh when a retryable thinking 400 is surfaced as text', async () => {
    const outputs: string[] = [];
    const deps = makeDeps();

    vi.mocked(sessionRecovery.shouldRetryFreshSessionOnAgentFailure)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'intermediate',
          result:
            'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.11.content.0: Invalid `signature` in `thinking` block"}}',
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
          result: 'fresh Claude retry success',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'claude-session-fresh',
        };
      });

    const result = await runAgentForGroup(deps, {
      group: makeGroup(),
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-retryable-thinking-400-retry',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(deps.clearSession).toHaveBeenCalledTimes(1);
    expect(deps.clearSession).toHaveBeenCalledWith('test-claude');
    // No fallback provider — rotation is the only recovery mechanism
    expect(outputs).toEqual(['fresh Claude retry success']);
  });

  it('returns error when the fresh Claude retry also hits the same retryable thinking 400', async () => {
    const outputs: string[] = [];
    const deps = makeDeps();

    vi.mocked(sessionRecovery.shouldRetryFreshSessionOnAgentFailure)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'intermediate',
          result:
            'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.11.content.0: Invalid `signature` in `thinking` block"}}',
        });
        return {
          status: 'success',
          result: null,
        };
      })
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'intermediate',
          result:
            'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.11.content.0: Invalid `signature` in `thinking` block"}}',
        });
        return {
          status: 'success',
          result: null,
        };
      });

    const result = await runAgentForGroup(deps, {
      group: makeGroup(),
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-retryable-thinking-400-error',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('error');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(deps.clearSession).toHaveBeenCalledTimes(2);
    expect(outputs).toEqual([]);
  });

  it('returns error after all Claude accounts are usage-exhausted', async () => {
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
            'You\u2019re out of extra usage \u00b7 resets 4am (Asia/Seoul)',
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
          result: "You're out of extra usage \u00b7 resets 4am (Asia/Seoul)",
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
      runId: 'run-all-exhausted-error',
      startSeq: 10,
      endSeq: 12,
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(tokenRotation.rotateToken).toHaveBeenCalledTimes(2);
    expect(outputs).toEqual([]);
    expect(serviceRouting.activateCodexFailover).toHaveBeenCalledWith(
      'group@test',
      'claude-usage-exhausted',
    );
    expect(db.createServiceHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_jid: 'group@test',
        target_service_id: 'codex-review',
        target_agent_type: 'codex',
        start_seq: 10,
        end_seq: 12,
        reason: 'claude-usage-exhausted',
      }),
    );
  });

  it('suppresses a usage-exhausted banner even when Claude already emitted progress text', async () => {
    const outputs: string[] = [];

    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(1);

    vi.mocked(agentRunner.runAgentProcess).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '대화 요약 중...',
        });
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: "You've hit your limit · resets 2am (Asia/Seoul)",
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
      runId: 'run-progress-before-usage-banner',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('error');
    expect(outputs).toEqual(['대화 요약 중...']);
    expect(db.createServiceHandoff).not.toHaveBeenCalled();
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
    // No fallback provider — rotation is the only recovery mechanism
    expect(outputs).toEqual(['org access denied 회전 성공 응답']);
  });

  it('rotates when Claude surfaces 403 terminated as a success result', async () => {
    const outputs: string[] = [];

    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(2);
    vi.mocked(tokenRotation.rotateToken).mockReturnValueOnce(true);

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'Failed to authenticate. API Error: 403 terminated',
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
          result: '403 회전 성공 응답',
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
      runId: 'run-403-success-rotation',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(tokenRotation.rotateToken).toHaveBeenCalledTimes(1);
    expect(outputs).toEqual(['403 회전 성공 응답']);
  });

  it('returns error after all Claude accounts are org-access-denied', async () => {
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
      });

    const result = await runAgentForGroup(makeDeps(), {
      group: makeGroup(),
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-org-access-denied-error',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(tokenRotation.rotateToken).toHaveBeenCalledTimes(2);
    expect(outputs).toEqual([]);
    expect(serviceRouting.activateCodexFailover).toHaveBeenCalledWith(
      'group@test',
      'claude-org-access-denied',
    );
    expect(db.createServiceHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_jid: 'group@test',
        target_service_id: 'codex-review',
        target_agent_type: 'codex',
        reason: 'claude-org-access-denied',
      }),
    );
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
    expect(outputs).toEqual([
      "상태 문구 예시: You're out of extra usage · resets 4am (Asia/Seoul) 라는 배너가 뜰 수 있습니다.",
    ]);
  });
});

describe('runAgentForGroup Codex rotation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(buildRoomMemoryBriefing).mockResolvedValue(undefined);
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
