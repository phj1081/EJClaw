import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as config from './config.js';

const NO_VISIBLE_VERDICT_SUMMARY = `검토 중입니다.\nExecution completed without a visible terminal verdict.`;
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
  OWNER_AGENT_TYPE: 'codex',
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
    getRoomRoleAgentConfig: vi.fn(() => undefined),
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
import * as db from './db.js';
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

describe('runAgentForGroup paired turn revision guards', () => {
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
});

describe('runAgentForGroup paired turn state', () => {
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
});

describe('runAgentForGroup reviewer verdict visibility', () => {
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
        summary: NO_VISIBLE_VERDICT_SUMMARY,
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
      error: NO_VISIBLE_VERDICT_SUMMARY,
    });
    expect(db.completePairedTurn).not.toHaveBeenCalled();
    expect(db.insertPairedTurnOutput).not.toHaveBeenCalled();
  });
});

describe('runAgentForGroup direct terminal delivery', () => {
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
});

describe('runAgentForGroup paired workspace and blocking', () => {
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
});
