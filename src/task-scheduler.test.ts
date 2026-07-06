import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runAgentProcessMock,
  writeTasksSnapshotMock,
  loggerDebugMock,
  checkGitHubActionsRunMock,
} = vi.hoisted(() => ({
  runAgentProcessMock: vi.fn(async () => ({
    status: 'success' as const,
    result: 'done',
  })),
  writeTasksSnapshotMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  checkGitHubActionsRunMock: vi.fn(
    async (): Promise<{
      terminal: boolean;
      resultSummary: string;
      completionMessage?: string;
    }> => ({
      terminal: false,
      resultSummary: 'GitHub Actions run 123 is in_progress',
    }),
  ),
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

vi.mock('./agent-runner.js', async () => {
  const actual =
    await vi.importActual<typeof import('./agent-runner.js')>(
      './agent-runner.js',
    );
  return {
    ...actual,
    runAgentProcess: runAgentProcessMock,
    writeTasksSnapshot: writeTasksSnapshotMock,
  };
});

vi.mock('./logger.js', () => {
  const mockLogger = {
    debug: loggerDebugMock,
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

vi.mock('./github-ci.js', () => ({
  checkGitHubActionsRun: checkGitHubActionsRunMock,
  computeGitHubWatcherDelayMs: vi.fn(
    (task: { schedule_value: string; created_at: string }, nowMs: number) => {
      const baseDelayMs = Number.parseInt(task.schedule_value, 10);
      const normalizedBaseDelayMs =
        Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 15_000;
      const createdAtMs = new Date(task.created_at).getTime();
      const elapsedMs = Number.isFinite(createdAtMs)
        ? Math.max(0, nowMs - createdAtMs)
        : 0;

      if (elapsedMs >= 60 * 60 * 1000) {
        return Math.max(normalizedBaseDelayMs, 60_000);
      }
      if (elapsedMs >= 10 * 60 * 1000) {
        return Math.max(normalizedBaseDelayMs, 30_000);
      }
      return normalizedBaseDelayMs;
    },
  ),
  MAX_GITHUB_CONSECUTIVE_ERRORS: 5,
  parseGitHubCiMetadata: vi.fn((raw: string | null | undefined) => {
    if (!raw) return null;
    return JSON.parse(raw);
  }),
  serializeGitHubCiMetadata: vi.fn((metadata: unknown) =>
    JSON.stringify(metadata),
  ),
}));

vi.mock('./service-routing.js', () => ({
  hasReviewerLease: vi.fn(() => false),
}));

import {
  _initTestDatabase,
  createPairedTask,
  createTask,
  getTaskById,
} from './db.js';
import * as codexTokenRotation from './codex-token-rotation.js';
import * as serviceRouting from './service-routing.js';
import * as tokenRefresh from './token-refresh.js';
import * as tokenRotation from './token-rotation.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  runSchedulerTickOnce,
  startSchedulerLoop,
} from './task-scheduler.js';

beforeEach(() => {
  _initTestDatabase();
  _resetSchedulerLoopForTests();
  runAgentProcessMock.mockClear();
  writeTasksSnapshotMock.mockClear();
  loggerDebugMock.mockClear();
  checkGitHubActionsRunMock.mockClear();
  checkGitHubActionsRunMock.mockResolvedValue({
    terminal: false,
    resultSummary: 'GitHub Actions run 123 is in_progress',
  });
  // No fallback provider setup needed
  vi.mocked(tokenRotation.getTokenCount).mockReturnValue(1);
  vi.mocked(tokenRotation.getCurrentTokenIndex).mockReturnValue(0);
  vi.mocked(tokenRotation.markTokenHealthy).mockClear();
  vi.mocked(tokenRotation.rotateToken).mockClear();
  vi.mocked(tokenRotation.rotateToken).mockReturnValue(false);
  vi.mocked(tokenRefresh.forceRefreshToken).mockReset();
  vi.mocked(tokenRefresh.forceRefreshToken).mockResolvedValue(null);
  vi.mocked(codexTokenRotation.rotateCodexToken).mockClear();
  vi.mocked(codexTokenRotation.rotateCodexToken).mockReturnValue(false);
  vi.mocked(codexTokenRotation.getCodexAccountCount).mockReturnValue(1);
  vi.mocked(codexTokenRotation.markCodexTokenHealthy).mockClear();
  vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(false);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('task scheduler queueing', () => {
  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      roomBindings: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('enqueues due tasks across agent types in unified service mode', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-claude',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'claude-code',
      prompt: 'claude task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });
    createTask({
      id: 'task-codex',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      prompt: 'codex task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2026-02-22T00:00:01.000Z',
    });

    const enqueueTask = vi.fn();

    startSchedulerLoop({
      serviceAgentType: 'codex',
      roomBindings: () => ({
        'shared@g.us': {
          name: 'Shared',
          folder: 'shared-group',
          trigger: '@Codex',
          added_at: '2026-02-22T00:00:00.000Z',
          agentType: 'codex',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).toHaveBeenCalledTimes(2);
    expect(
      enqueueTask.mock.calls
        .map(([queueJid, taskId]) => `${queueJid}|${taskId}`)
        .sort(),
    ).toEqual(
      [
        'shared@g.us::task:task-claude|task-claude',
        'shared@g.us::task:task-codex|task-codex',
      ].sort(),
    );
  });

  it('requeues an orphaned review_ready paired task once its CI watcher is gone', async () => {
    createPairedTask({
      id: 'paired-review-ready-orphan',
      chat_jid: 'review@g.us',
      group_folder: 'review-group',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      round_trip_count: 1,
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      owner_failure_count: 0,
      created_at: '2026-02-22T00:00:00.000Z',
      updated_at: '2026-02-22T00:00:01.000Z',
    });

    const enqueueMessageCheck = vi.fn();
    const deps = {
      serviceAgentType: 'codex' as const,
      roomBindings: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask: vi.fn(), enqueueMessageCheck } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    };

    await runSchedulerTickOnce(deps);

    expect(enqueueMessageCheck).toHaveBeenCalledTimes(1);
    expect(enqueueMessageCheck).toHaveBeenCalledWith(
      'review@g.us',
      expect.stringContaining('review-group'),
    );

    await runSchedulerTickOnce(deps);
    expect(enqueueMessageCheck).toHaveBeenCalledTimes(1);
  });

  it('can execute one scheduler tick without starting the timer loop', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-single-tick',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      prompt: 'single tick task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn();

    await runSchedulerTickOnce({
      serviceAgentType: 'codex',
      roomBindings: () => ({
        'shared@g.us': {
          name: 'Shared',
          folder: 'shared-group',
          trigger: '@Codex',
          added_at: '2026-02-22T00:00:00.000Z',
          agentType: 'codex',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask.mock.calls[0][0]).toBe(
      'shared@g.us::task:task-single-tick',
    );
    expect(enqueueTask.mock.calls[0][1]).toBe('task-single-tick');
  });
});

describe('task scheduler execution outcomes', () => {
  it('marks one-off tasks completed after a successful scheduler run', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-once-success-finalize',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      prompt: 'finalize once task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    let execution: Promise<void> | null = null;
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        execution = fn();
        return execution;
      },
    );

    await runSchedulerTickOnce({
      serviceAgentType: 'codex',
      roomBindings: () => ({
        'shared@g.us': {
          name: 'Shared',
          folder: 'shared-group',
          trigger: '@Codex',
          added_at: '2026-02-22T00:00:00.000Z',
          agentType: 'codex',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });
    await execution;

    const task = getTaskById('task-once-success-finalize');
    expect(task?.status).toBe('completed');
    expect(task?.next_run).toBeNull();
    expect(task?.last_result).toBe('done');
  });

  it('keeps interval tasks active and reschedules them after an execution error', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-interval-error-retry',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      prompt: 'retry interval task',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    (runAgentProcessMock as any).mockResolvedValueOnce({
      status: 'error',
      error: 'scheduler boom',
    });

    let execution: Promise<void> | null = null;
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        execution = fn();
        return execution;
      },
    );

    await runSchedulerTickOnce({
      serviceAgentType: 'codex',
      roomBindings: () => ({
        'shared@g.us': {
          name: 'Shared',
          folder: 'shared-group',
          trigger: '@Codex',
          added_at: '2026-02-22T00:00:00.000Z',
          agentType: 'codex',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });
    await execution;

    const task = getTaskById('task-interval-error-retry');
    expect(task?.status).toBe('active');
    expect(task?.last_result).toBe('Error: scheduler boom');
    expect(task?.next_run).not.toBe(dueAt);
    expect(task?.next_run).not.toBeNull();
  });

  it('keeps group-context tasks on the chat queue key', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-group-context',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      prompt: 'group context task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'group',
      next_run: dueAt,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn();

    startSchedulerLoop({
      serviceAgentType: 'codex',
      roomBindings: () => ({
        'shared@g.us': {
          name: 'Shared',
          folder: 'shared-group',
          trigger: '@Codex',
          added_at: '2026-02-22T00:00:00.000Z',
          agentType: 'codex',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask.mock.calls[0][0]).toBe('shared@g.us');
    expect(enqueueTask.mock.calls[0][1]).toBe('task-group-context');
  });

  it('keeps watch_ci tasks on a dedicated queue even in group context', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-watch-group',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 123456

Check instructions:
Check the run.
      `.trim(),
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'group',
      next_run: dueAt,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn();

    startSchedulerLoop({
      serviceAgentType: 'codex',
      roomBindings: () => ({
        'shared@g.us': {
          name: 'Shared',
          folder: 'shared-group',
          trigger: '@Codex',
          added_at: '2026-02-22T00:00:00.000Z',
          agentType: 'codex',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask.mock.calls[0][0]).toBe(
      'shared@g.us::task:task-watch-group',
    );
    expect(enqueueTask.mock.calls[0][1]).toBe('task-watch-group');
  });
});

describe('computeNextRun', () => {
  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      agent_type: 'claude-code' as const,
      status_message_id: null,
      status_started_at: null,
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      agent_type: 'claude-code' as const,
      status_message_id: null,
      status_started_at: null,
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      agent_type: 'claude-code' as const,
      status_message_id: null,
      status_started_at: null,
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});
