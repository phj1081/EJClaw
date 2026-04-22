import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as config from './config.js';

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
import type { AgentOutput } from './agent-runner.js';
import * as codexTokenRotation from './codex-token-rotation.js';
import * as db from './db.js';
import { logger } from './logger.js';
import { buildRoomMemoryBriefing } from './sqlite-memory-store.js';
import { runAgentForGroup } from './message-agent-executor.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';
import * as pairedExecutionContext from './paired-execution-context.js';
import * as sessionRecovery from './session-recovery.js';
import * as serviceRouting from './service-routing.js';
import * as tokenRefresh from './token-refresh.js';
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
    getRoomBindings: () => ({}),
    getSessions: () => ({}),
    persistSession: vi.fn(),
    clearSession: vi.fn(),
  };
}

const ORIGINAL_UNSAFE_HOST_PAIRED_MODE =
  process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE;

describe('runAgentForGroup room memory', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPairedFollowUpScheduleState();
    delete process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE;
    vi.mocked(
      config.shouldForceFreshClaudeReviewerSessionInUnsafeHostMode,
    ).mockReturnValue(false);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'ok',
          output: { visibility: 'public', text: 'ok' },
          phase: 'final',
        });
        return { status: 'success', result: 'ok', newSessionId: 'session-123' };
      },
    );
    vi.mocked(buildRoomMemoryBriefing).mockResolvedValue(
      '## Shared Room Memory\n- remembered context',
    );
  });

  afterAll(() => {
    if (ORIGINAL_UNSAFE_HOST_PAIRED_MODE === undefined) {
      delete process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE;
    } else {
      process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE =
        ORIGINAL_UNSAFE_HOST_PAIRED_MODE;
    }
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
      expect.any(Function),
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
      expect.any(Function),
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
      expect.any(Function),
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
        roomRoleContext: expect.objectContaining({
          serviceId: 'claude',
          role: 'owner',
          ownerServiceId: 'claude',
          reviewerServiceId: 'codex-review',
          failoverOwner: false,
        }),
      }),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );
  });

  it('keeps the reviewer prompt unchanged when the current service is the reviewer for the chat', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
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
      expect.any(Function),
      undefined,
    );
  });

  it('preserves reviewer role metadata for same-service review turns', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
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
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'paired-task-review',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: '2026-03-29T00:00:00.000Z',
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-29T00:00:00.000Z',
      updated_at: '2026-03-29T00:00:00.000Z',
    });

    await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-same-service-reviewer',
    });

    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        roomRoleContext: expect.objectContaining({
          serviceId: 'claude',
          role: 'reviewer',
          ownerServiceId: 'claude',
          reviewerServiceId: 'claude',
          failoverOwner: false,
        }),
      }),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );
  });

  it('honors a forced reviewer role even when the paired task status is active', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      arbiter_service_id: null,
      activated_at: null,
      reason: null,
      explicit: false,
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'paired-task-active',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: '2026-03-31T00:00:00.000Z',
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-31T00:00:00.000Z',
      updated_at: '2026-03-31T00:00:00.000Z',
    });

    await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'please retry review',
      chatJid: 'group@test',
      runId: 'run-forced-reviewer',
      forcedRole: 'reviewer',
    });

    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        roomRoleContext: expect.objectContaining({
          serviceId: 'claude',
          role: 'reviewer',
          ownerServiceId: 'codex-main',
          reviewerServiceId: 'claude',
          failoverOwner: false,
        }),
      }),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );
  });

  it('honors a forced agent type for reviewer failover handoffs', async () => {
    const group: RegisteredGroup = {
      ...makeGroup(),
      agentType: 'codex',
      folder: 'test-group',
    };
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      arbiter_service_id: null,
      activated_at: null,
      reason: null,
      explicit: false,
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'paired-task-reviewer-failover',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: '2026-03-31T00:00:00.000Z',
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-31T00:00:00.000Z',
      updated_at: '2026-03-31T00:00:00.000Z',
    });

    await runAgentForGroup(
      {
        ...makeDeps(),
        getSessions: () => ({ 'test-group:reviewer': 'claude-review-session' }),
      },
      {
        group,
        prompt: 'please retry review with codex',
        chatJid: 'group@test',
        runId: 'run-forced-reviewer-codex',
        forcedRole: 'reviewer',
        forcedAgentType: 'codex',
      },
    );

    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'codex',
      }),
      expect.objectContaining({
        sessionId: undefined,
      }),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );
  });

  it('does not inject reviewer model overrides into a forced codex fallback run', async () => {
    const group: RegisteredGroup = {
      ...makeGroup(),
      agentType: 'codex',
      folder: 'test-group',
    };
    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-reviewer-failover-model',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'codex-main',
        reviewer_service_id: 'claude',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        round_trip_count: 0,
        review_requested_at: '2026-03-31T00:00:00.000Z',
        status: 'active',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-03-31T00:00:00.000Z',
        updated_at: '2026-03-31T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {},
    });
    const config = await import('./config.js');
    vi.mocked(config.getRoleModelConfig).mockReturnValue({
      model: 'claude-opus-4-6',
      effort: 'high',
      fallbackEnabled: true,
    });

    await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'please retry review with codex',
      chatJid: 'group@test',
      runId: 'run-forced-reviewer-codex-model',
      forcedRole: 'reviewer',
      forcedAgentType: 'codex',
    });

    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'codex',
      }),
      expect.any(Object),
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        EJCLAW_PAIRED_TURN_ID:
          'paired-task-reviewer-failover-model:2026-03-31T00:00:00.000Z:reviewer-turn',
        EJCLAW_PAIRED_TURN_ROLE: 'reviewer',
        EJCLAW_PAIRED_TURN_INTENT: 'reviewer-turn',
      }),
    );
  });

  it('fails closed when a persisted paired turn revision mismatches the prepared execution context', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };

    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-stale-revision',
        chat_jid: 'group@test',
        group_folder: 'test-group',
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
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T01:00:00.000Z',
      },
      workspace: null,
      envOverrides: {},
    });

    await expect(
      runAgentForGroup(makeDeps(), {
        group,
        prompt: 'hello',
        chatJid: 'group@test',
        runId: 'run-stale-paired-turn-revision',
        pairedTurnIdentity: {
          turnId:
            'paired-task-stale-revision:2026-04-10T00:00:00.000Z:owner-follow-up',
          taskId: 'paired-task-stale-revision',
          taskUpdatedAt: '2026-04-10T00:00:00.000Z',
          intentKind: 'owner-follow-up',
          role: 'owner',
        },
      }),
    ).rejects.toThrow(
      /task_updated_at does not match the prepared execution context/,
    );

    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
  });

  it('allows a claimed paired turn revision when preparation advances the task before execution', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };

    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-prep-advance',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'claude',
        reviewer_service_id: 'codex-review',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        round_trip_count: 0,
        review_requested_at: '2026-04-10T00:00:00.000Z',
        status: 'in_review',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T01:00:00.000Z',
      },
      claimedTaskUpdatedAt: '2026-04-10T00:00:00.000Z',
      workspace: null,
      envOverrides: {},
    });

    await expect(
      runAgentForGroup(makeDeps(), {
        group,
        prompt: 'hello',
        chatJid: 'group@test',
        runId: 'run-claimed-paired-turn-revision',
        forcedRole: 'reviewer',
        pairedTurnIdentity: {
          turnId:
            'paired-task-prep-advance:2026-04-10T00:00:00.000Z:reviewer-turn',
          taskId: 'paired-task-prep-advance',
          taskUpdatedAt: '2026-04-10T00:00:00.000Z',
          intentKind: 'reviewer-turn',
          role: 'reviewer',
        },
      }),
    ).resolves.toBe('success');

    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    const [
      effectiveGroup,
      agentInput,
      _registerProcess,
      _onOutput,
      envOverrides,
    ] = vi.mocked(agentRunner.runAgentProcess).mock.calls[0]!;
    expect(effectiveGroup).toEqual(
      expect.objectContaining({
        folder: 'test-group',
        agentType: 'codex',
      }),
    );
    expect(agentInput).toEqual(
      expect.objectContaining({
        roomRoleContext: expect.objectContaining({
          role: 'reviewer',
          reviewerAgentType: 'codex',
          serviceId: 'codex-review',
        }),
      }),
    );
    expect(envOverrides).toEqual(
      expect.objectContaining({
        EJCLAW_PAIRED_TURN_ID:
          'paired-task-prep-advance:2026-04-10T00:00:00.000Z:reviewer-turn',
        EJCLAW_PAIRED_TURN_ROLE: 'reviewer',
        EJCLAW_PAIRED_TURN_INTENT: 'reviewer-turn',
        EJCLAW_PAIRED_TASK_UPDATED_AT: '2026-04-10T00:00:00.000Z',
      }),
    );
  });

  it('fails closed when a persisted paired turn revision mismatches the latest paired task fallback', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };

    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue(undefined);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'paired-task-stale-fallback',
      chat_jid: 'group@test',
      group_folder: 'test-group',
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
      created_at: '2026-04-10T00:00:00.000Z',
      updated_at: '2026-04-10T01:00:00.000Z',
    });

    await expect(
      runAgentForGroup(makeDeps(), {
        group,
        prompt: 'hello',
        chatJid: 'group@test',
        runId: 'run-stale-paired-turn-fallback',
        pairedTurnIdentity: {
          turnId:
            'paired-task-stale-fallback:2026-04-10T00:00:00.000Z:owner-follow-up',
          taskId: 'paired-task-stale-fallback',
          taskUpdatedAt: '2026-04-10T00:00:00.000Z',
          intentKind: 'owner-follow-up',
          role: 'owner',
        },
      }),
    ).rejects.toThrow(/task_updated_at does not match the latest paired task/);

    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
  });

  it('persists logical turn state transitions while a paired turn runs successfully', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };

    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-stateful-owner',
        chat_jid: 'group@test',
        group_folder: 'test-group',
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
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {},
    });

    const result = await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-paired-turn-stateful-owner',
    });

    expect(result).toBe('success');
    expect(db.markPairedTurnRunning).toHaveBeenCalledWith({
      turnIdentity: {
        turnId:
          'paired-task-stateful-owner:2026-04-10T00:00:00.000Z:owner-follow-up',
        taskId: 'paired-task-stateful-owner',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        intentKind: 'owner-follow-up',
        role: 'owner',
      },
      executorServiceId: 'claude',
      executorAgentType: 'claude-code',
      runId: 'run-paired-turn-stateful-owner',
    });
    expect(db.completePairedTurn).toHaveBeenCalledWith({
      turnId:
        'paired-task-stateful-owner:2026-04-10T00:00:00.000Z:owner-follow-up',
      taskId: 'paired-task-stateful-owner',
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'owner-follow-up',
      role: 'owner',
    });
  });

  it('suppresses stale owner finalize output when another run already owns the active paired attempt', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    const onOutput = vi.fn(async () => {});

    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-stale-owner-final',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'claude',
        reviewer_service_id: 'codex-review',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        round_trip_count: 0,
        review_requested_at: null,
        status: 'merge_ready',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {},
    });
    vi.mocked(db.getPairedTurnAttempts).mockReturnValue([
      {
        attempt_id:
          'paired-task-stale-owner-final:2026-04-10T00:00:00.000Z:finalize-owner-turn:attempt:2',
        parent_attempt_id:
          'paired-task-stale-owner-final:2026-04-10T00:00:00.000Z:finalize-owner-turn:attempt:1',
        parent_handoff_id: null,
        continuation_handoff_id: null,
        turn_id:
          'paired-task-stale-owner-final:2026-04-10T00:00:00.000Z:finalize-owner-turn',
        attempt_no: 2,
        task_id: 'paired-task-stale-owner-final',
        task_updated_at: '2026-04-10T00:00:00.000Z',
        role: 'owner',
        intent_kind: 'finalize-owner-turn',
        state: 'running',
        executor_service_id: 'claude',
        executor_agent_type: 'claude-code',
        active_run_id: 'run-new-owner-attempt',
        created_at: '2026-04-10T00:00:01.000Z',
        updated_at: '2026-04-10T00:00:01.000Z',
        completed_at: null,
        last_error: null,
      },
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, emitOutput) => {
        await emitOutput?.({
          status: 'success',
          result: 'DONE\nowner final from stale attempt',
          output: {
            visibility: 'public',
            text: 'DONE\nowner final from stale attempt',
          },
          phase: 'final',
        } as any);
        return {
          status: 'success',
          result: 'DONE\nowner final from stale attempt',
        };
      },
    );

    const result = await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'finalize please',
      chatJid: 'group@test',
      runId: 'run-stale-owner-attempt',
      pairedTurnIdentity: {
        turnId:
          'paired-task-stale-owner-final:2026-04-10T00:00:00.000Z:finalize-owner-turn',
        taskId: 'paired-task-stale-owner-final',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        intentKind: 'finalize-owner-turn',
        role: 'owner',
      },
      onOutput,
    });

    expect(result).toBe('success');
    expect(onOutput).not.toHaveBeenCalled();
    expect(db.insertPairedTurnOutput).not.toHaveBeenCalled();
    expect(
      pairedExecutionContext.completePairedExecutionContext,
    ).not.toHaveBeenCalled();
    expect(db.completePairedTurn).not.toHaveBeenCalled();
    expect(db.failPairedTurn).not.toHaveBeenCalled();
  });

  it('allows silent reviewer outputs', async () => {
    const group = { ...makeGroup(), folder: 'test-group', workDir: '/repo' };
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
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
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
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

  it('fails paired reviewer turns that finish without a visible terminal verdict', async () => {
    const group = {
      ...makeGroup(),
      folder: 'test-group',
      workDir: '/repo',
      agentType: 'codex' as const,
    };
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
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
    });
    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-review-no-verdict',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'claude',
        reviewer_service_id: 'codex-review',
        title: null,
        source_ref: 'HEAD',
        review_requested_at: '2026-04-10T00:00:00.000Z',
        plan_notes: null,
        round_trip_count: 0,
        status: 'in_review',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      },
      claimedTaskUpdatedAt: '2026-04-10T00:00:00.000Z',
      workspace: null,
      envOverrides: {},
      requiresVisibleVerdict: true,
    });
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '검토 중입니다.',
          output: { visibility: 'public', text: '검토 중입니다.' },
        } as any);
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const result = await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'hello',
      chatJid: 'group@test',
      runId: 'run-review-no-verdict',
      forcedRole: 'reviewer',
      pairedTurnIdentity: {
        turnId:
          'paired-task-review-no-verdict:2026-04-10T00:00:00.000Z:reviewer-turn',
        taskId: 'paired-task-review-no-verdict',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        intentKind: 'reviewer-turn',
        role: 'reviewer',
      },
    });

    expect(result).toBe('success');
    expect(
      pairedExecutionContext.completePairedExecutionContext,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'paired-task-review-no-verdict',
        role: 'reviewer',
        status: 'failed',
        summary: 'Execution completed without a visible terminal verdict.',
      }),
    );
    expect(db.failPairedTurn).toHaveBeenCalledWith({
      turnIdentity: {
        turnId:
          'paired-task-review-no-verdict:2026-04-10T00:00:00.000Z:reviewer-turn',
        taskId: 'paired-task-review-no-verdict',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        intentKind: 'reviewer-turn',
        role: 'reviewer',
      },
      error: 'Execution completed without a visible terminal verdict.',
    });
    expect(db.completePairedTurn).not.toHaveBeenCalled();
    expect(db.insertPairedTurnOutput).not.toHaveBeenCalled();
  });

  it('adopts a direct terminal reviewer delivery as the paired final output and avoids requeue', async () => {
    const group = {
      ...makeGroup(),
      folder: 'test-group',
      workDir: '/repo',
      agentType: 'codex' as const,
    };
    const deps = {
      ...makeDeps(),
      queue: {
        registerProcess: vi.fn(),
        enqueueMessageCheck: vi.fn(),
        getDirectTerminalDeliveryForRun: vi.fn(
          (groupJid: string, runId: string, senderRole?: string | null) =>
            groupJid === 'group@test' &&
            runId === 'run-review-direct-terminal' &&
            senderRole === 'reviewer'
              ? 'DONE_WITH_CONCERNS\n핵심 concern이 있습니다.'
              : null,
        ),
      },
    };

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
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
    });
    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-review-direct-terminal',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'claude',
        reviewer_service_id: 'codex-review',
        title: null,
        source_ref: 'HEAD',
        review_requested_at: '2026-04-10T00:00:00.000Z',
        plan_notes: null,
        round_trip_count: 1,
        status: 'in_review',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      },
      claimedTaskUpdatedAt: '2026-04-10T00:00:00.000Z',
      workspace: null,
      envOverrides: {},
      requiresVisibleVerdict: true,
    });
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'paired-task-review-direct-terminal',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-04-10T00:00:00.000Z',
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-04-10T00:00:00.000Z',
      updated_at: '2026-04-10T00:00:00.000Z',
    });
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '리뷰 완료했습니다. 핵심 concern을 정리 중입니다.',
          output: {
            visibility: 'public',
            text: '리뷰 완료했습니다. 핵심 concern을 정리 중입니다.',
          },
        } as any);
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const result = await runAgentForGroup(deps, {
      group,
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-review-direct-terminal',
      forcedRole: 'reviewer',
      pairedTurnIdentity: {
        turnId:
          'paired-task-review-direct-terminal:2026-04-10T00:00:00.000Z:reviewer-turn',
        taskId: 'paired-task-review-direct-terminal',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        intentKind: 'reviewer-turn',
        role: 'reviewer',
      },
      onOutput: async () => {},
    });

    expect(result).toBe('success');
    expect(
      pairedExecutionContext.completePairedExecutionContext,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'paired-task-review-direct-terminal',
        role: 'reviewer',
        status: 'succeeded',
        summary: 'DONE_WITH_CONCERNS\n핵심 concern이 있습니다.',
      }),
    );
    expect(db.insertPairedTurnOutput).toHaveBeenCalledWith(
      'paired-task-review-direct-terminal',
      1,
      'reviewer',
      'DONE_WITH_CONCERNS\n핵심 concern이 있습니다.',
    );
    expect(db.completePairedTurn).toHaveBeenCalledWith({
      turnId:
        'paired-task-review-direct-terminal:2026-04-10T00:00:00.000Z:reviewer-turn',
      taskId: 'paired-task-review-direct-terminal',
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });
    expect(db.failPairedTurn).not.toHaveBeenCalled();
    expect(deps.queue.enqueueMessageCheck).not.toHaveBeenCalled();
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
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
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
      expect.any(Function),
      expect.objectContaining({
        EJCLAW_WORK_DIR: '/tmp/paired/owner',
        EJCLAW_PAIRED_TASK_ID: 'paired-task-1',
        EJCLAW_PAIRED_ROLE: 'owner',
      }),
    );
    // The shared attempt harness now routes runner output through the streamed
    // evaluator, so a visible public result is treated as a successful owner
    // turn.
    expect(
      pairedExecutionContext.completePairedExecutionContext,
    ).toHaveBeenCalledWith({
      taskId: 'paired-task-1',
      role: 'owner',
      runId: 'run-room-role',
      status: 'succeeded',
      summary: 'ok',
    });
  });

  it('does not emit an extra public done notification after owner finalization completes the paired task', async () => {
    const group = {
      ...makeGroup(),
      folder: 'test-group',
      workDir: '/repo/canonical',
    };
    const outputs: string[] = [];

    vi.mocked(db.getLastHumanMessageSender).mockReturnValue(
      '216851709744513024',
    );
    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-final-done',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'claude',
        reviewer_service_id: 'codex-main',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        round_trip_count: 1,
        review_requested_at: '2026-04-09T00:00:00.000Z',
        status: 'merge_ready',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-09T00:00:00.000Z',
        updated_at: '2026-04-09T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {},
    });
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'paired-task-final-done',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-04-09T00:00:00.000Z',
      status: 'completed',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: 'done',
      created_at: '2026-04-09T00:00:00.000Z',
      updated_at: '2026-04-09T00:00:01.000Z',
    });
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'DONE\nfinalized',
          output: { visibility: 'public', text: 'DONE\nfinalized' },
          phase: 'final',
        });
        return {
          status: 'success',
          result: 'DONE\nfinalized',
        };
      },
    );

    const result = await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'finalize',
      chatJid: 'group@test',
      runId: 'run-final-done',
      onOutput: async (output) => {
        if (output.output?.visibility === 'public' && output.output.text) {
          outputs.push(output.output.text);
        }
      },
    });

    expect(result).toBe('success');
    expect(outputs).toEqual(['DONE\nfinalized']);
  });

  it('still emits escalation notifications when the paired task completes with human intervention required', async () => {
    const group = {
      ...makeGroup(),
      folder: 'test-group',
      workDir: '/repo/canonical',
    };
    const outputs: string[] = [];

    vi.mocked(db.getLastHumanMessageSender).mockReturnValue(
      '216851709744513024',
    );
    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-final-escalated',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'claude',
        reviewer_service_id: 'codex-main',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        round_trip_count: 1,
        review_requested_at: '2026-04-09T00:00:00.000Z',
        status: 'merge_ready',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-09T00:00:00.000Z',
        updated_at: '2026-04-09T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {},
    });
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'paired-task-final-escalated',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-04-09T00:00:00.000Z',
      status: 'completed',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: 'escalated',
      created_at: '2026-04-09T00:00:00.000Z',
      updated_at: '2026-04-09T00:00:01.000Z',
    });
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'BLOCKED\nhuman intervention required',
          output: {
            visibility: 'public',
            text: 'BLOCKED\nhuman intervention required',
          },
          phase: 'final',
        });
        return {
          status: 'success',
          result: 'BLOCKED\nhuman intervention required',
        };
      },
    );

    const result = await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'finalize',
      chatJid: 'group@test',
      runId: 'run-final-escalated',
      onOutput: async (output) => {
        if (output.output?.visibility === 'public' && output.output.text) {
          outputs.push(output.output.text);
        }
      },
    });

    expect(result).toBe('success');
    expect(outputs).toEqual([
      'BLOCKED\nhuman intervention required',
      '<@216851709744513024> ⚠️ 자동 해결 불가 — 확인이 필요합니다.',
    ]);
  });

  it('logs streamed activity with resolved execution attribution', async () => {
    const group = {
      ...makeGroup(),
      folder: 'test-group',
      workDir: '/repo/canonical',
    };

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
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
        id: 'paired-task-reviewer-log',
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
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-03-28T00:00:00.000Z',
        updated_at: '2026-03-28T00:00:00.000Z',
      },
      workspace: {
        id: 'paired-task-reviewer-log:reviewer',
        task_id: 'paired-task-reviewer-log',
        role: 'reviewer',
        workspace_dir: '/tmp/paired/reviewer',
        snapshot_source_dir: '/repo/canonical',
        snapshot_ref: 'HEAD',
        status: 'ready',
        snapshot_refreshed_at: null,
        created_at: '2026-03-28T00:00:00.000Z',
        updated_at: '2026-03-28T00:00:00.000Z',
      },
      envOverrides: {
        EJCLAW_WORK_DIR: '/tmp/paired/reviewer',
        EJCLAW_PAIRED_TASK_ID: 'paired-task-reviewer-log',
        EJCLAW_PAIRED_ROLE: 'reviewer',
      },
    });
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'apply_patch setup/service.ts',
          phase: 'progress',
          newSessionId: 'session-progress-1',
        });
        await onOutput?.({
          status: 'success',
          result: 'DONE\nreview complete',
          output: { visibility: 'public', text: 'DONE\nreview complete' },
          phase: 'final',
          newSessionId: 'session-final-1',
        });
        return {
          status: 'success',
          result: 'DONE\nreview complete',
          newSessionId: 'session-final-1',
        };
      },
    );

    await runAgentForGroup(makeDeps(), {
      group,
      prompt: 'please review this change',
      chatJid: 'group@test',
      runId: 'run-attribution-log',
      forcedRole: 'reviewer',
      onOutput: async () => {},
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        outputPhase: 'progress',
        outputStatus: 'success',
        activeRole: 'reviewer',
        effectiveAgentType: 'claude-code',
        roomRoleServiceId: 'claude',
        roomRole: 'reviewer',
        pairedTaskId: 'paired-task-reviewer-log',
        workspaceDir: '/tmp/paired/reviewer',
        preview: 'apply_patch setup/service.ts',
        streamedSessionId: 'session-progress-1',
      }),
      'Observed streamed agent activity',
    );
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
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
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
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
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
      runId: 'run-blocked-reviewer',
      status: 'failed',
      summary:
        'Review snapshot is stale after owner changes. Retry the review once to refresh against the latest owner workspace.',
    });
    expect(
      pairedExecutionContext.completePairedExecutionContext,
    ).toHaveBeenCalledTimes(1);
  });

  it('uses the role plan for reviewer execution while keeping task snapshots on the owner agent', async () => {
    const group = {
      ...makeGroup(),
      folder: 'test-group',
      agentType: 'codex' as const,
    };
    const deps = {
      ...makeDeps(),
      getSessions: () => ({ 'test-group:reviewer': 'reviewer-session' }),
    };

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      arbiter_service_id: null,
      activated_at: null,
      reason: null,
      explicit: false,
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'paired-task-review',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: '2026-03-31T00:00:00.000Z',
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-31T00:00:00.000Z',
      updated_at: '2026-03-31T00:00:00.000Z',
    });

    await runAgentForGroup(deps, {
      group,
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-review-plan',
    });

    expect(db.getAllTasks).toHaveBeenCalledWith('codex');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: 'test-group',
        agentType: 'claude-code',
      }),
      expect.objectContaining({
        sessionId: 'reviewer-session',
      }),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );
  });

  it('keeps reviewer Claude session in unsafe host mode by default', async () => {
    process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE = '1';
    const group = {
      ...makeGroup(),
      folder: 'test-group',
      agentType: 'codex' as const,
    };
    const deps = {
      ...makeDeps(),
      getSessions: () => ({ 'test-group:reviewer': 'reviewer-session' }),
    };

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      arbiter_service_id: null,
      activated_at: null,
      reason: null,
      explicit: false,
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'paired-task-review',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: '2026-03-31T00:00:00.000Z',
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-31T00:00:00.000Z',
      updated_at: '2026-03-31T00:00:00.000Z',
    });
    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-review',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'codex-main',
        reviewer_service_id: 'claude',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        round_trip_count: 0,
        review_requested_at: '2026-03-31T00:00:00.000Z',
        status: 'review_ready',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-03-31T00:00:00.000Z',
        updated_at: '2026-03-31T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {
        EJCLAW_PAIRED_TASK_ID: 'paired-task-review',
        EJCLAW_PAIRED_ROLE: 'reviewer',
        EJCLAW_UNSAFE_HOST_PAIRED_MODE: '1',
        CLAUDE_CONFIG_DIR: '/tmp/test-group-reviewer',
      },
    });
    vi.mocked(agentRunner.runAgentProcess).mockResolvedValue({
      status: 'success',
      result: 'review ok',
      newSessionId: 'review-session-new',
    });

    await runAgentForGroup(deps, {
      group,
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-review-plan-unsafe-host',
    });

    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: 'test-group',
        agentType: 'claude-code',
      }),
      expect.objectContaining({
        sessionId: 'reviewer-session',
      }),
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        EJCLAW_UNSAFE_HOST_PAIRED_MODE: '1',
      }),
    );
    expect(deps.clearSession).not.toHaveBeenCalled();
  });

  it('starts reviewer Claude fresh in unsafe host mode when explicitly forced', async () => {
    process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE = '1';
    vi.mocked(
      config.shouldForceFreshClaudeReviewerSessionInUnsafeHostMode,
    ).mockReturnValue(true);
    const group = {
      ...makeGroup(),
      folder: 'test-group',
      agentType: 'codex' as const,
    };
    const deps = {
      ...makeDeps(),
      getSessions: () => ({ 'test-group:reviewer': 'reviewer-session' }),
    };

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      arbiter_service_id: null,
      activated_at: null,
      reason: null,
      explicit: false,
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'paired-task-review',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: '2026-03-31T00:00:00.000Z',
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-31T00:00:00.000Z',
      updated_at: '2026-03-31T00:00:00.000Z',
    });
    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-review',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'codex-main',
        reviewer_service_id: 'claude',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        round_trip_count: 0,
        review_requested_at: '2026-03-31T00:00:00.000Z',
        status: 'review_ready',
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-03-31T00:00:00.000Z',
        updated_at: '2026-03-31T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {
        EJCLAW_PAIRED_TASK_ID: 'paired-task-review',
        EJCLAW_PAIRED_ROLE: 'reviewer',
        EJCLAW_UNSAFE_HOST_PAIRED_MODE: '1',
        CLAUDE_CONFIG_DIR: '/tmp/test-group-reviewer',
      },
    });
    vi.mocked(agentRunner.runAgentProcess).mockResolvedValue({
      status: 'success',
      result: 'review ok',
      newSessionId: 'review-session-new',
    });

    await runAgentForGroup(deps, {
      group,
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-review-plan-unsafe-host-fresh',
    });

    expect(deps.clearSession).toHaveBeenCalledWith('test-group:reviewer');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: 'test-group',
        agentType: 'claude-code',
      }),
      expect.objectContaining({
        sessionId: undefined,
      }),
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        EJCLAW_UNSAFE_HOST_PAIRED_MODE: '1',
      }),
    );
    expect(deps.persistSession).not.toHaveBeenCalled();
  });

  it('does not enqueue a second generic follow-up when reviewer approval already moved the task to merge_ready', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    const deps = makeDeps();

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
        id: 'paired-task-merge-ready',
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
      id: 'paired-task-merge-ready',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-03-31T00:00:00.000Z',
      status: 'merge_ready',
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
          result: 'DONE\nreview complete',
          output: { visibility: 'public', text: 'DONE\nreview complete' },
          phase: 'final',
        });
        return {
          status: 'success',
          result: 'DONE\nreview complete',
        };
      },
    );

    const result = await runAgentForGroup(deps, {
      group,
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-review-merge-ready',
      forcedRole: 'reviewer',
      onOutput: async () => {},
    });

    expect(result).toBe('success');
    expect(deps.queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('does not enqueue an executor-side follow-up when owner output moved the task to review_ready', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    const deps = makeDeps();

    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-owner-review-ready',
        chat_jid: 'group@test',
        group_folder: 'test-group',
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
        created_at: '2026-03-31T00:00:00.000Z',
        updated_at: '2026-03-31T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {},
    });
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'paired-task-owner-review-ready',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
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
          result: 'DONE_WITH_CONCERNS\nowner complete',
          output: {
            visibility: 'public',
            text: 'DONE_WITH_CONCERNS\nowner complete',
          },
          phase: 'final',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\nowner complete',
        };
      },
    );

    const result = await runAgentForGroup(deps, {
      group,
      prompt: 'please implement',
      chatJid: 'group@test',
      runId: 'run-owner-review-ready',
      onOutput: async () => {},
    });

    expect(result).toBe('success');
    expect(deps.queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('stores owner turn output and completes the paired task before delivery', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    const deps = makeDeps();
    const onOutput = vi.fn(async () => {});

    vi.mocked(
      pairedExecutionContext.preparePairedExecutionContext,
    ).mockReturnValue({
      task: {
        id: 'paired-task-owner-output-order',
        chat_jid: 'group@test',
        group_folder: 'test-group',
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
        created_at: '2026-03-31T00:00:00.000Z',
        updated_at: '2026-03-31T00:00:00.000Z',
      },
      workspace: null,
      envOverrides: {},
    });
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, forwardOutput) => {
        await forwardOutput?.({
          status: 'success',
          result: 'DONE_WITH_CONCERNS\nowner complete',
          output: {
            visibility: 'public',
            text: 'DONE_WITH_CONCERNS\nowner complete',
          },
          phase: 'final',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\nowner complete',
        };
      },
    );

    const result = await runAgentForGroup(deps, {
      group,
      prompt: 'please implement',
      chatJid: 'group@test',
      runId: 'run-owner-output-order',
      onOutput,
    });

    expect(result).toBe('success');
    expect(db.insertPairedTurnOutput).toHaveBeenCalledWith(
      'paired-task-owner-output-order',
      1,
      'owner',
      'DONE_WITH_CONCERNS\nowner complete',
    );
    expect(
      vi.mocked(db.insertPairedTurnOutput).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(pairedExecutionContext.completePairedExecutionContext).mock
        .invocationCallOrder[0],
    );
    expect(
      vi.mocked(pairedExecutionContext.completePairedExecutionContext).mock
        .invocationCallOrder[0],
    ).toBeLessThan(onOutput.mock.invocationCallOrder[0]);
    expect(
      vi.mocked(pairedExecutionContext.completePairedExecutionContext),
    ).toHaveBeenCalledWith({
      taskId: 'paired-task-owner-output-order',
      role: 'owner',
      runId: 'run-owner-output-order',
      status: 'succeeded',
      summary: 'DONE_WITH_CONCERNS\nowner complete',
    });
  });

  it('stores reviewer turn output before transitioning the paired task back to active', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    const deps = makeDeps();
    const onOutput = vi.fn(async () => {});

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
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
        id: 'paired-task-reviewer-output-order',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'codex-main',
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
      id: 'paired-task-reviewer-output-order',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-03-31T00:00:00.000Z',
      status: 'active',
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
          result: 'DONE_WITH_CONCERNS\nreviewer feedback',
          output: {
            visibility: 'public',
            text: 'DONE_WITH_CONCERNS\nreviewer feedback',
          },
          phase: 'final',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\nreviewer feedback',
        };
      },
    );

    const result = await runAgentForGroup(deps, {
      group,
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-reviewer-output-order',
      forcedRole: 'reviewer',
      onOutput,
    });

    expect(result).toBe('success');
    expect(db.insertPairedTurnOutput).toHaveBeenCalledWith(
      'paired-task-reviewer-output-order',
      1,
      'reviewer',
      'DONE_WITH_CONCERNS\nreviewer feedback',
    );
    expect(
      vi.mocked(db.insertPairedTurnOutput).mock.invocationCallOrder[0],
    ).toBeLessThan(onOutput.mock.invocationCallOrder[0]);
    expect(
      vi.mocked(db.insertPairedTurnOutput).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(pairedExecutionContext.completePairedExecutionContext).mock
        .invocationCallOrder[0],
    );
  });

  it('stores reviewer approval output before transitioning the paired task to merge_ready', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    const deps = makeDeps();
    const onOutput = vi.fn(async () => {});

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
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
        id: 'paired-task-reviewer-approval-order',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'codex-main',
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
      id: 'paired-task-reviewer-approval-order',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-03-31T00:00:00.000Z',
      status: 'merge_ready',
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
          result: 'DONE\nreviewer approval',
          output: {
            visibility: 'public',
            text: 'DONE\nreviewer approval',
          },
          phase: 'final',
        });
        return {
          status: 'success',
          result: 'DONE\nreviewer approval',
        };
      },
    );

    const result = await runAgentForGroup(deps, {
      group,
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-reviewer-approval-order',
      forcedRole: 'reviewer',
      onOutput,
    });

    expect(result).toBe('success');
    expect(db.insertPairedTurnOutput).toHaveBeenCalledWith(
      'paired-task-reviewer-approval-order',
      1,
      'reviewer',
      'DONE\nreviewer approval',
    );
    expect(
      vi.mocked(db.insertPairedTurnOutput).mock.invocationCallOrder[0],
    ).toBeLessThan(onOutput.mock.invocationCallOrder[0]);
    expect(
      vi.mocked(db.insertPairedTurnOutput).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(pairedExecutionContext.completePairedExecutionContext).mock
        .invocationCallOrder[0],
    );
  });

  it('does not enqueue a generic follow-up when reviewer output already returned the task to active', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    const deps = makeDeps();

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'group@test',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'codex-main',
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
        id: 'paired-task-reviewer-active',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'codex-main',
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
      id: 'paired-task-reviewer-active',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-03-31T00:00:00.000Z',
      status: 'active',
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
          result: 'DONE_WITH_CONCERNS\nreview complete',
          output: {
            visibility: 'public',
            text: 'DONE_WITH_CONCERNS\nreview complete',
          },
          phase: 'final',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\nreview complete',
        };
      },
    );

    const result = await runAgentForGroup(deps, {
      group,
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-reviewer-active',
      forcedRole: 'reviewer',
      onOutput: async () => {},
    });

    expect(result).toBe('success');
    expect(deps.queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('re-enqueues the group when a reviewer fails and the task remains review_ready', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    const deps = makeDeps();

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
        id: 'paired-task-review-ready',
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
      id: 'paired-task-review-ready',
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
    vi.mocked(agentRunner.runAgentProcess).mockResolvedValue({
      status: 'error',
      result: null,
      error: 'SDK crashed with exit code 1',
    });

    const result = await runAgentForGroup(deps, {
      group,
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-review-ready-requeue',
      forcedRole: 'reviewer',
      onOutput: async () => {},
    });

    expect(result).toBe('error');
    expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith('group@test');
  });

  it('does not re-enqueue the same review_ready follow-up twice in one run', async () => {
    const group = { ...makeGroup(), folder: 'test-group' };
    const deps = makeDeps();

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
        id: 'paired-task-review-ready-dedup',
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
      id: 'paired-task-review-ready-dedup',
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
    vi.mocked(agentRunner.runAgentProcess).mockResolvedValue({
      status: 'error',
      result: null,
      error: 'SDK crashed with exit code 1',
    });

    await runAgentForGroup(deps, {
      group,
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-review-ready-requeue-dedup',
      forcedRole: 'reviewer',
      onOutput: async () => {},
    });
    await runAgentForGroup(deps, {
      group,
      prompt: 'please review',
      chatJid: 'group@test',
      runId: 'run-review-ready-requeue-dedup',
      forcedRole: 'reviewer',
      onOutput: async () => {},
    });

    expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'paired-task-review-ready-dedup',
        role: 'reviewer',
        pairedExecutionStatus: 'failed',
        taskStatus: 'review_ready',
        intentKind: 'reviewer-turn',
        scheduled: false,
      }),
      'Skipped duplicate paired follow-up after failed reviewer/arbiter execution while task state was unchanged',
    );
  });
});

describe('runAgentForGroup Claude rotation', () => {
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

  it('drops a poisoned Codex session id before retrying a fresh session after remote compaction failure', async () => {
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
        throw new Error(
          "Error running remote compact task: Unknown parameter: 'prompt_cache_retention'",
        );
      })
      .mockImplementationOnce(async (_group, input, _onProcess, onOutput) => {
        expect(input.sessionId).toBeUndefined();
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'fresh Codex retry success',
        });
        return {
          status: 'success',
          result: 'fresh Codex retry success',
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
        source_role: 'owner',
        source_agent_type: 'claude-code',
        target_role: 'owner',
        target_agent_type: 'codex',
        reason: 'claude-org-access-denied',
        intended_role: 'owner',
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
