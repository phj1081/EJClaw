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
  ARBITER_SERVICE_ID: null,
  CLAUDE_SERVICE_ID: 'claude',
  CODEX_MAIN_SERVICE_ID: 'codex-main',
  CODEX_REVIEW_SERVICE_ID: 'codex-review',
  DATA_DIR: '/tmp/ejclaw-test-data',
  PAIRED_FORCE_FRESH_CLAUDE_REVIEWER_SESSION: false,
  REVIEWER_AGENT_TYPE: 'claude-code',
  ARBITER_AGENT_TYPE: undefined,
  SERVICE_SESSION_SCOPE: 'claude',
  shouldForceFreshClaudeReviewerSessionInUnsafeHostMode: vi.fn(() => false),
  isClaudeService: vi.fn(() => true),
  normalizeServiceId: vi.fn((serviceId: string) =>
    serviceId === 'codex' ? 'codex-main' : serviceId,
  ),
  getRoleModelConfig: vi.fn(() => ({
    model: undefined,
    effort: undefined,
    fallbackEnabled: true,
  })),
  getMoaConfig: vi.fn(() => ({
    enabled: false,
    referenceModels: [],
    aggregator: {},
  })),
  TIMEZONE: 'Asia/Seoul',
}));

vi.mock('./arbiter-context.js', () => ({
  buildArbiterContextPrompt: vi.fn(() => ''),
}));

vi.mock('./moa.js', () => ({
  runMoaArbiter: vi.fn(),
}));

vi.mock('./platform-prompts.js', () => ({
  readArbiterPrompt: vi.fn(() => ''),
}));

vi.mock('./db.js', () => {
  const pairedTurnReservations = new Set<string>();
  const claimedTaskRevisions = new Set<string>();
  const buildReservationKey = (args: {
    chatJid: string;
    taskId: string;
    taskUpdatedAt: string;
    intentKind: string;
  }) =>
    [args.chatJid, args.taskId, args.taskUpdatedAt, args.intentKind].join(':');

  return {
    completePairedTurn: vi.fn(),
    createServiceHandoff: vi.fn(),
    failPairedTurn: vi.fn(),
    getAllTasks: vi.fn(() => []),
    getLastHumanMessageSender: vi.fn(() => null),
    getLatestOpenPairedTaskForChat: vi.fn(() => undefined),
    getLatestTurnNumber: vi.fn(() => 0),
    getPairedTaskById: vi.fn(() => undefined),
    getPairedTurnAttempts: vi.fn(() => []),
    getPairedTurnOutputs: vi.fn(() => []),
    insertPairedTurnOutput: vi.fn(),
    markPairedTurnRunning: vi.fn(),
    refreshPairedTaskExecutionLease: vi.fn(() => true),
    releasePairedTaskExecutionLease: vi.fn(),
    reservePairedTurnReservation: vi.fn((args) => {
      const key = buildReservationKey(args);
      if (pairedTurnReservations.has(key)) {
        return false;
      }
      pairedTurnReservations.add(key);
      return true;
    }),
    claimPairedTurnReservation: vi.fn((args) => {
      const revisionKey = [args.taskId, args.taskUpdatedAt].join(':');
      if (claimedTaskRevisions.has(revisionKey)) {
        return false;
      }
      claimedTaskRevisions.add(revisionKey);
      pairedTurnReservations.add(
        buildReservationKey({
          chatJid: args.chatJid,
          taskId: args.taskId,
          taskUpdatedAt: args.taskUpdatedAt,
          intentKind: args.intentKind,
        }),
      );
      return true;
    }),
    _clearPairedTurnReservationsForTests: vi.fn(() => {
      pairedTurnReservations.clear();
      claimedTaskRevisions.clear();
    }),
  };
});

vi.mock('./service-routing.js', () => ({
  activateCodexFailover: vi.fn(),
  clearGlobalFailover: vi.fn(),
  getEffectiveChannelLease: vi.fn(() => ({
    chat_jid: 'group@test',
    owner_agent_type: 'claude-code',
    reviewer_agent_type: 'codex',
    arbiter_agent_type: null,
    owner_service_id: 'claude',
    reviewer_service_id: 'codex-review',
    arbiter_service_id: null,
    activated_at: null,
    reason: null,
    explicit: false,
  })),
  resolveLeaseServiceId: vi.fn(
    (
      lease: {
        owner_service_id: string;
        reviewer_service_id: string | null;
        arbiter_service_id: string | null;
        owner_agent_type?: 'claude-code' | 'codex';
        reviewer_agent_type?: 'claude-code' | 'codex' | null;
        arbiter_agent_type?: 'claude-code' | 'codex' | null;
        owner_failover_active?: boolean;
      },
      role: 'owner' | 'reviewer' | 'arbiter',
    ) => {
      if (role === 'owner') {
        return lease.owner_failover_active
          ? lease.owner_service_id
          : lease.owner_agent_type === 'codex'
            ? 'codex-main'
            : 'claude';
      }
      if (role === 'reviewer') {
        if (lease.reviewer_agent_type === 'codex') {
          return 'codex-review';
        }
        return lease.reviewer_service_id;
      }
      if (lease.arbiter_agent_type === 'codex') {
        return lease.arbiter_service_id ?? 'codex-review';
      }
      return lease.arbiter_service_id;
    },
  ),
}));

vi.mock('./logger.js', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (_bindings?: Record<string, unknown>) => mockLogger,
  };
  return {
    logger: mockLogger,
    createScopedLogger: (_bindings?: Record<string, unknown>) => mockLogger,
  };
});

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
  shouldResetCodexSessionOnAgentFailure: vi.fn(() => false),
  shouldResetSessionOnAgentFailure: vi.fn(() => false),
  shouldRetryFreshCodexSessionOnAgentFailure: vi.fn(() => false),
  shouldRetryFreshSessionOnAgentFailure: vi.fn(() => false),
}));

vi.mock('./token-rotation.js', () => ({
  rotateToken: vi.fn(() => false),
  getTokenCount: vi.fn(() => 1),
  getCurrentTokenIndex: vi.fn(() => 0),
  markTokenHealthy: vi.fn(),
}));

vi.mock('./token-refresh.js', () => ({
  forceRefreshToken: vi.fn(async () => null),
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

vi.mock('./sqlite-memory-store.js', () => ({
  buildRoomMemoryBriefing: vi.fn(),
}));

vi.mock('./paired-execution-context.js', () => ({
  completePairedExecutionContext: vi.fn(),
  preparePairedExecutionContext: vi.fn(() => undefined),
}));

import * as agentRunner from './agent-runner.js';
import * as codexTokenRotation from './codex-token-rotation.js';
import * as db from './db.js';
import { buildRoomMemoryBriefing } from './sqlite-memory-store.js';
import { runAgentForGroup } from './message-agent-executor.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';
import * as pairedExecutionContext from './paired-execution-context.js';
import * as sessionRecovery from './session-recovery.js';
import * as serviceRouting from './service-routing.js';
import * as tokenRefresh from './token-refresh.js';
import * as tokenRotation from './token-rotation.js';
import type { RegisteredGroup } from './types.js';
import {
  makeDeps,
  makeGroup,
} from '../test/helpers/message-agent-executor-fixtures.js';

describe('runAgentForGroup Claude rotation on usage exhaustion', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPairedFollowUpScheduleState();
    vi.mocked(buildRoomMemoryBriefing).mockResolvedValue(undefined);
    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(1);
    vi.mocked(tokenRotation.getCurrentTokenIndex).mockReturnValue(0);
    vi.mocked(tokenRotation.rotateToken).mockReturnValue(false);
    vi.mocked(tokenRefresh.forceRefreshToken).mockResolvedValue(null);
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
        source_role: 'owner',
        source_agent_type: 'claude-code',
        target_role: 'owner',
        target_agent_type: 'codex',
        start_seq: 10,
        end_seq: 12,
        reason: 'claude-usage-exhausted',
        intended_role: 'owner',
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

describe('runAgentForGroup Claude rotation on auth expiry', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPairedFollowUpScheduleState();
    vi.mocked(buildRoomMemoryBriefing).mockResolvedValue(undefined);
    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(1);
    vi.mocked(tokenRotation.getCurrentTokenIndex).mockReturnValue(0);
    vi.mocked(tokenRotation.rotateToken).mockReturnValue(false);
    vi.mocked(tokenRefresh.forceRefreshToken).mockResolvedValue(null);
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

  it('force-refreshes the active Claude token before rotating on auth-expired', async () => {
    const outputs: string[] = [];

    vi.mocked(tokenRefresh.forceRefreshToken).mockResolvedValueOnce(
      'new-access-token',
    );

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
          result: 'force refresh 뒤 Claude 응답입니다.',
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
      runId: 'run-auth-expired-force-refresh',
      onOutput: async (output) => {
        if (typeof output.result === 'string') outputs.push(output.result);
      },
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(tokenRefresh.forceRefreshToken).toHaveBeenCalledWith(0);
    expect(tokenRotation.rotateToken).not.toHaveBeenCalled();
    expect(tokenRotation.markTokenHealthy).toHaveBeenCalledTimes(1);
    expect(outputs).toEqual(['force refresh 뒤 Claude 응답입니다.']);
  });

  it('marks paired execution as succeeded when Claude rotation recovers after a streamed auth-expired trigger', async () => {
    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(2);
    vi.mocked(tokenRotation.rotateToken).mockReturnValueOnce(true);
    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-claude-rotation-success',
        chat_jid: 'group@test',
        group_folder: 'test-claude',
        owner_service_id: 'claude',
        reviewer_service_id: 'codex-review',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        round_trip_count: 0,
        review_requested_at: null,
        status: 'active',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-06T00:00:00.000Z',
        updated_at: '2026-04-06T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {},
    });

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
          result: '회전 복구 후 paired success',
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
      runId: 'run-paired-auth-expired-success',
      onOutput: async () => {},
    });

    expect(result).toBe('success');
    expect(
      pairedExecutionContext.completePairedExecutionContext,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'paired-task-claude-rotation-success',
        role: 'owner',
        status: 'succeeded',
      }),
    );
  });
});

describe('runAgentForGroup Claude transient and session retries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPairedFollowUpScheduleState();
    vi.mocked(buildRoomMemoryBriefing).mockResolvedValue(undefined);
    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(1);
    vi.mocked(tokenRotation.getCurrentTokenIndex).mockReturnValue(0);
    vi.mocked(tokenRotation.rotateToken).mockReturnValue(false);
    vi.mocked(tokenRefresh.forceRefreshToken).mockResolvedValue(null);
  });

  it('suppresses Claude 502 HTML and returns error when no rotation is available', async () => {
    const outputs: string[] = [];

    // Persistent 502: initial attempt + same-account transient retries all fail
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
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
    // 1 initial attempt + 2 same-account transient retries for 502/overloaded
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(3);
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

  it('hands off to codex when the fresh Claude retry also hits the same retryable thinking 400', async () => {
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

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(deps.clearSession).toHaveBeenCalledTimes(2);
    expect(outputs).toEqual([]);
    expect(serviceRouting.activateCodexFailover).toHaveBeenCalledWith(
      'group@test',
      'claude-session-failure',
    );
    expect(db.createServiceHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_jid: 'group@test',
        source_role: 'owner',
        target_role: 'owner',
        source_agent_type: 'claude-code',
        target_agent_type: 'codex',
        reason: 'claude-session-failure',
        intended_role: 'owner',
      }),
    );
  });
});

describe('runAgentForGroup Claude session failure handoffs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPairedFollowUpScheduleState();
    vi.mocked(buildRoomMemoryBriefing).mockResolvedValue(undefined);
    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(1);
    vi.mocked(tokenRotation.getCurrentTokenIndex).mockReturnValue(0);
    vi.mocked(tokenRotation.rotateToken).mockReturnValue(false);
    vi.mocked(tokenRefresh.forceRefreshToken).mockResolvedValue(null);
  });

  it('hands off to codex after repeated retryable Claude session failures', async () => {
    vi.mocked(
      sessionRecovery.shouldRetryFreshSessionOnAgentFailure,
    ).mockReturnValue(true);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: null,
        });
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const deps = makeDeps();
    const result = await runAgentForGroup(deps, {
      group: makeGroup(),
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-session-failure-handoff',
      startSeq: 3,
      endSeq: 7,
      onOutput: async () => {},
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(deps.clearSession).toHaveBeenCalledTimes(2);
    expect(serviceRouting.activateCodexFailover).toHaveBeenCalledWith(
      'group@test',
      'claude-session-failure',
    );
    expect(db.createServiceHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_jid: 'group@test',
        source_role: 'owner',
        target_role: 'owner',
        source_agent_type: 'claude-code',
        target_agent_type: 'codex',
        start_seq: 3,
        end_seq: 7,
        reason: 'claude-session-failure',
        intended_role: 'owner',
      }),
    );
  });

  it('does not enqueue generic paired reviewer recovery after delegating to a fallback handoff', async () => {
    vi.mocked(
      sessionRecovery.shouldRetryFreshSessionOnAgentFailure,
    ).mockReturnValue(true);
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'claude',
      reviewer_service_id: 'claude',
      arbiter_service_id: null,
      activated_at: null,
      reason: null,
      explicit: false,
    });
    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-reviewer-handoff-delegated',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'claude',
        reviewer_service_id: 'claude',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        round_trip_count: 1,
        review_requested_at: '2026-03-31T00:00:00.000Z',
        status: 'in_review',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-03-31T00:00:00.000Z',
        updated_at: '2026-03-31T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {},
    });
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'paired-task-reviewer-handoff-delegated',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-03-31T00:00:00.000Z',
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-31T00:00:00.000Z',
      updated_at: '2026-03-31T00:00:00.000Z',
    });
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: null,
        });
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const deps = makeDeps();
    const result = await runAgentForGroup(deps, {
      group: makeGroup(),
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-reviewer-delegated-handoff',
      forcedRole: 'reviewer',
      onOutput: async () => {},
    });

    expect(result).toBe('success');
    expect(db.createServiceHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_jid: 'group@test',
        paired_task_id: 'paired-task-reviewer-handoff-delegated',
        paired_task_updated_at: '2026-03-31T00:00:00.000Z',
        turn_id:
          'paired-task-reviewer-handoff-delegated:2026-03-31T00:00:00.000Z:reviewer-turn',
        turn_intent_kind: 'reviewer-turn',
        turn_role: 'reviewer',
        source_role: 'reviewer',
        target_role: 'reviewer',
        intended_role: 'reviewer',
      }),
    );
    expect(
      pairedExecutionContext.completePairedExecutionContext,
    ).not.toHaveBeenCalled();
    expect(deps.queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('drops a stale Claude session id before retrying a fresh session', async () => {
    const deps = {
      ...makeDeps(),
      getSessions: () => ({ 'test-claude': 'stale-session-id' }),
    };

    vi.mocked(sessionRecovery.shouldRetryFreshSessionOnAgentFailure)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, input) => {
        expect(input.sessionId).toBe('stale-session-id');
        throw new Error(
          'No conversation found with session ID: stale-session-id',
        );
      })
      .mockImplementationOnce(async (_group, input, _onProcess, onOutput) => {
        expect(input.sessionId).toBeUndefined();
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'fresh retry success',
        });
        return {
          status: 'success',
          result: 'fresh retry success',
          newSessionId: 'fresh-session-id',
        };
      });

    const result = await runAgentForGroup(deps, {
      group: makeGroup(),
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-stale-session-id-retry',
      onOutput: async () => {},
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(deps.clearSession).toHaveBeenCalledWith('test-claude');
  });
});

describe('runAgentForGroup Claude org access and Codex session recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPairedFollowUpScheduleState();
    vi.mocked(buildRoomMemoryBriefing).mockResolvedValue(undefined);
    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(1);
    vi.mocked(tokenRotation.getCurrentTokenIndex).mockReturnValue(0);
    vi.mocked(tokenRotation.rotateToken).mockReturnValue(false);
    vi.mocked(tokenRefresh.forceRefreshToken).mockResolvedValue(null);
  });

  it('drops a poisoned Codex session id before retrying after context-window overflow', async () => {
    const group = {
      ...makeGroup(),
      folder: 'test-codex',
      agentType: 'codex' as const,
    };
    const deps = {
      ...makeDeps(),
      getSessions: () => ({ 'test-codex': 'stale-codex-session-id' }),
    };

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'codex',
      reviewer_agent_type: null,
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
      reviewer_service_id: null,
      arbiter_service_id: null,
      activated_at: null,
      reason: null,
      explicit: false,
    });
    vi.mocked(sessionRecovery.shouldRetryFreshCodexSessionOnAgentFailure)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(sessionRecovery.shouldResetCodexSessionOnAgentFailure)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, input) => {
        expect(input.sessionId).toBe('stale-codex-session-id');
        return {
          status: 'error',
          result: null,
          error: "Codex ran out of room in the model's context window.",
          newSessionId: 'stale-codex-session-id',
        };
      })
      .mockImplementationOnce(async (_group, input, _onProcess, onOutput) => {
        expect(input.sessionId).toBeUndefined();
        await onOutput?.({ status: 'success', phase: 'final', result: 'ok' });
        return {
          status: 'success',
          result: 'ok',
          newSessionId: 'fresh-codex-session-id',
        };
      });

    const result = await runAgentForGroup(deps, {
      group,
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-stale-codex-session-id-retry',
      onOutput: async () => {},
    });

    expect(result).toBe('success');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(deps.clearSession).toHaveBeenCalledWith('test-codex');
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
        source_role: 'owner',
        source_agent_type: 'claude-code',
        target_role: 'owner',
        target_agent_type: 'codex',
        reason: 'claude-org-access-denied',
        intended_role: 'owner',
      }),
    );
  });
});

describe('runAgentForGroup Codex rotation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPairedFollowUpScheduleState();
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

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'codex',
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      arbiter_service_id: null,
      activated_at: null,
      reason: null,
      explicit: false,
    });

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
