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
import { logger } from './logger.js';
import { buildRoomMemoryBriefing } from './sqlite-memory-store.js';
import { runAgentForGroup } from './message-agent-executor.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';
import * as pairedExecutionContext from './paired-execution-context.js';
import * as serviceRouting from './service-routing.js';
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

describe('runAgentForGroup completion notifications', () => {
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
});

describe('runAgentForGroup streamed activity attribution', () => {
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
});

describe('runAgentForGroup paired output persistence order', () => {
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
});

describe('runAgentForGroup reviewer approval persistence', () => {
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
});

describe('runAgentForGroup follow-up suppression', () => {
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
});

describe('runAgentForGroup reviewer failure requeue', () => {
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
