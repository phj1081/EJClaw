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
import * as db from './db.js';
import { buildRoomMemoryBriefing } from './sqlite-memory-store.js';
import { runAgentForGroup } from './message-agent-executor.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';
import * as pairedExecutionContext from './paired-execution-context.js';
import * as serviceRouting from './service-routing.js';
import type { RegisteredGroup } from './types.js';
import {
  makeDeps,
  makeGroup,
} from '../test/helpers/message-agent-executor-fixtures.js';

const ORIGINAL_UNSAFE_HOST_PAIRED_MODE =
  process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE;

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

describe('runAgentForGroup room memory briefing', () => {
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
});

describe('runAgentForGroup role metadata', () => {
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
});

describe('runAgentForGroup forced roles and agent overrides', () => {
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
      model: 'claude-opus-4-8',
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
});

describe('runAgentForGroup reviewer session reuse', () => {
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
});

describe('runAgentForGroup forced fresh reviewer session', () => {
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
});
