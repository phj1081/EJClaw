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

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import * as codexTokenRotation from './codex-token-rotation.js';
import { TIMEZONE } from './config.js';
import * as serviceRouting from './service-routing.js';
import * as tokenRefresh from './token-refresh.js';
import { createTaskStatusTracker } from './task-status-tracker.js';
import { TASK_STATUS_MESSAGE_PREFIX } from './task-watch-status.js';
import * as tokenRotation from './token-rotation.js';
import {
  _resetSchedulerLoopForTests,
  extractWatchCiTarget,
  isWatchCiTask,
  nudgeSchedulerLoop,
  renderWatchCiStatusMessage,
  runSchedulerTickOnce,
  startSchedulerLoop,
} from './task-scheduler.js';

function formatExpectedTimeLabel(timestampIso: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: TIMEZONE,
  })
    .format(new Date(timestampIso))
    .replace(/:/g, '시 ')
    .replace(/시 (\d{2})$/, '분 $1초');
}

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

describe('CI watcher scheduling and runtime', () => {
  it('picks up newly due tasks immediately when nudged', async () => {
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
    expect(enqueueTask).not.toHaveBeenCalled();

    createTask({
      id: 'task-watch-immediate',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 654321

Check instructions:
Check the run.
      `.trim(),
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    nudgeSchedulerLoop();
    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask).toHaveBeenCalledWith(
      'shared@g.us::task:task-watch-immediate',
      'task-watch-immediate',
      expect.any(Function),
    );
  });

  it('uses dedicated IPC but shared session state for group-context CI watchers', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-watch-runtime',
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

    const enqueueTask = vi.fn(
      async (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        await fn();
      },
    );

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
      getSessions: () => ({ 'shared-group': 'session-123' }),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(runAgentProcessMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runtimeTaskId: 'task-watch-runtime',
        useTaskScopedSession: false,
        sessionId: 'session-123',
      }),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );
    expect(writeTasksSnapshotMock).toHaveBeenCalledWith(
      'shared-group',
      false,
      expect.any(Array),
      'task-watch-runtime',
    );
  });

  it('uses the host-driven GitHub watcher path without spawning an agent', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-github-running',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      ci_provider: 'github',
      ci_metadata: JSON.stringify({
        repo: 'owner/repo',
        run_id: 123456,
      }),
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 123456

Check instructions:
Managed by host-driven watcher.
      `.trim(),
      schedule_type: 'interval',
      schedule_value: '15000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      async (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        await fn();
      },
    );

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

    expect(checkGitHubActionsRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-github-running',
        ci_provider: 'github',
      }),
    );
    expect(runAgentProcessMock).not.toHaveBeenCalled();

    const task = getTaskById('task-github-running');
    expect(task).toBeDefined();
    expect(task?.next_run).not.toBe(dueAt);
    expect(task?.ci_metadata).toContain('"poll_count":1');
    expect(task?.ci_metadata).toContain('"consecutive_errors":0');
  });
});

describe('GitHub CI watcher lifecycle', () => {
  it('sends a final message and deletes terminal GitHub watcher tasks', async () => {
    checkGitHubActionsRunMock.mockResolvedValueOnce({
      terminal: true,
      resultSummary: '성공: owner/repo run 654321',
      completionMessage: 'CI 완료: GitHub Actions run 654321\n판정: 성공',
    });

    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-github-complete',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      ci_provider: 'github',
      ci_metadata: JSON.stringify({
        repo: 'owner/repo',
        run_id: 654321,
      }),
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 654321

Check instructions:
Managed by host-driven watcher.
      `.trim(),
      schedule_type: 'interval',
      schedule_value: '15000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const sendMessage = vi.fn(async () => {});
    const enqueueTask = vi.fn(
      async (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        await fn();
      },
    );

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
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sendMessage).toHaveBeenCalledWith(
      'shared@g.us',
      'CI 완료: GitHub Actions run 654321\n판정: 성공',
    );
    expect(runAgentProcessMock).not.toHaveBeenCalled();
    expect(getTaskById('task-github-complete')).toBeUndefined();
  });

  it('backs off long-running GitHub watchers based on elapsed time', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-github-backoff',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      ci_provider: 'github',
      ci_metadata: JSON.stringify({
        repo: 'owner/repo',
        run_id: 222222,
        poll_count: 9,
      }),
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 222222

Check instructions:
Managed by host-driven watcher.
      `.trim(),
      schedule_type: 'interval',
      schedule_value: '15000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: new Date(Date.now() - 11 * 60_000).toISOString(),
    });

    const enqueueTask = vi.fn(
      async (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        await fn();
      },
    );

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

    const task = getTaskById('task-github-backoff');
    expect(task).toBeDefined();
    expect(
      new Date(task!.next_run!).getTime() - Date.now(),
    ).toBeGreaterThanOrEqual(29_000);
    expect(task?.ci_metadata).toContain('"poll_count":10');
  });

  it('pauses GitHub watchers after repeated gh api failures', async () => {
    checkGitHubActionsRunMock.mockRejectedValueOnce(
      new Error('gh api failed: rate limit'),
    );

    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-github-pause',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      ci_provider: 'github',
      ci_metadata: JSON.stringify({
        repo: 'owner/repo',
        run_id: 333333,
        poll_count: 4,
        consecutive_errors: 4,
      }),
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 333333

Check instructions:
Managed by host-driven watcher.
      `.trim(),
      schedule_type: 'interval',
      schedule_value: '15000',
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const sendMessage = vi.fn(async () => {});
    const enqueueTask = vi.fn(
      async (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        await fn();
      },
    );

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
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-github-pause');
    expect(task?.status).toBe('paused');
    expect(task?.ci_metadata).toContain('"consecutive_errors":5');
    expect(sendMessage).toHaveBeenCalledWith(
      'shared@g.us',
      expect.stringContaining('gh api 연속 5회 실패'),
    );
    expect(runAgentProcessMock).not.toHaveBeenCalled();
  });
});

describe('task expiry and session isolation', () => {
  it('deletes active tasks that exceed max duration before they run', async () => {
    const enqueueTask = vi.fn();
    createTask({
      id: 'task-watch-expired',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      max_duration_ms: 60_000,
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 999999

Check instructions:
Check the run.
      `.trim(),
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'group',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

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
      getSessions: () => ({ 'shared-group': 'session-123' }),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(getTaskById('task-watch-expired')).toBeUndefined();
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(runAgentProcessMock).not.toHaveBeenCalled();
  });

  it('deletes expired tasks during a direct scheduler tick before enqueueing', async () => {
    const enqueueTask = vi.fn();
    createTask({
      id: 'task-watch-expired-direct',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      max_duration_ms: 60_000,
      prompt: 'expired direct tick task',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

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
      getSessions: () => ({ 'shared-group': 'session-123' }),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    expect(getTaskById('task-watch-expired-direct')).toBeUndefined();
    expect(enqueueTask).not.toHaveBeenCalled();
  });

  it('isolates both IPC and session state for isolated tasks', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-isolated-runtime',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'claude-code',
      prompt: 'run isolated task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      async (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        await fn();
      },
    );

    startSchedulerLoop({
      serviceAgentType: 'claude-code',
      roomBindings: () => ({
        'shared@g.us': {
          name: 'Shared',
          folder: 'shared-group',
          trigger: '@Claude',
          added_at: '2026-02-22T00:00:00.000Z',
          agentType: 'claude-code',
        },
      }),
      getSessions: () => ({ 'shared-group': 'session-123' }),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(runAgentProcessMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runtimeTaskId: 'task-isolated-runtime',
        useTaskScopedSession: true,
        sessionId: undefined,
      }),
      expect.any(Function),
      expect.any(Function),
      undefined,
    );
    expect(writeTasksSnapshotMock).toHaveBeenCalledWith(
      'shared-group',
      false,
      expect.any(Array),
      'task-isolated-runtime',
    );
  });
});

describe('watcher status rendering', () => {
  it('renders watcher heartbeat messages with target and timing', () => {
    const prompt = `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 123456

Check instructions:
Check the run.
`.trim();

    expect(isWatchCiTask({ prompt } as any)).toBe(true);
    expect(extractWatchCiTarget(prompt)).toBe('GitHub Actions run 123456');

    const rendered = renderWatchCiStatusMessage({
      task: {
        prompt,
        schedule_type: 'interval',
        schedule_value: '60000',
      } as any,
      phase: 'waiting',
      checkedAt: '2026-03-19T07:02:10.000Z',
      statusStartedAt: '2026-03-19T07:00:00.000Z',
      nextRun: '2026-03-19T07:04:10.000Z',
    });

    const expectedCheckedLabel = formatExpectedTimeLabel(
      '2026-03-19T07:02:10.000Z',
    );
    const expectedNextLabel = formatExpectedTimeLabel(
      '2026-03-19T07:04:10.000Z',
    );

    expect(rendered).toContain('CI 감시 중: GitHub Actions run 123456');
    expect(rendered).toContain('- 상태: 대기 중');
    expect(rendered).toContain(`- 마지막 확인: ${expectedCheckedLabel}`);
    expect(rendered).toContain('- 경과 시간: 2분 10초');
    expect(rendered).toContain('- 확인 간격: 1분');
    expect(rendered).toContain(`- 다음 확인: ${expectedNextLabel}`);
    expect(rendered).not.toContain('16:02:10');
    expect(rendered).not.toContain('16:04:10');
  });

  it('omits watcher elapsed time when tracking has not started yet', () => {
    const prompt = `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 123456

Check instructions:
Check the run.
`.trim();

    const rendered = renderWatchCiStatusMessage({
      task: {
        prompt,
        schedule_type: 'interval',
        schedule_value: '60000',
      } as any,
      phase: 'checking',
      checkedAt: '2026-03-19T07:02:10.000Z',
      statusStartedAt: null,
    });

    expect(rendered).not.toContain('- 경과 시간:');
  });

  it('edits the existing watcher status message with refreshed elapsed time', async () => {
    vi.setSystemTime(new Date('2026-03-19T07:00:00.000Z'));

    createTask({
      id: 'task-watch-status',
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
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const sendTrackedMessage = vi.fn(async () => 'msg-123');
    const editTrackedMessage = vi.fn(async () => {});

    const tracker = createTaskStatusTracker(getTaskById('task-watch-status')!, {
      sendTrackedMessage,
      editTrackedMessage,
    });

    await tracker.update('checking');

    const firstState = getTaskById('task-watch-status');
    expect(sendTrackedMessage).toHaveBeenCalledWith(
      'shared@g.us',
      expect.stringContaining(`${TASK_STATUS_MESSAGE_PREFIX}CI 감시 중:`),
    );
    expect(firstState?.status_message_id).toBe('msg-123');
    expect(firstState?.status_started_at).toBe('2026-03-19T07:00:00.000Z');

    vi.setSystemTime(new Date('2026-03-19T07:02:10.000Z'));
    await tracker.update('waiting', '2026-03-19T07:04:10.000Z');

    const expectedNextLabel = formatExpectedTimeLabel(
      '2026-03-19T07:04:10.000Z',
    );

    expect(editTrackedMessage).toHaveBeenCalledWith(
      'shared@g.us',
      'msg-123',
      expect.stringContaining('- 경과 시간: 2분 10초'),
    );
    expect(editTrackedMessage).toHaveBeenCalledWith(
      'shared@g.us',
      'msg-123',
      expect.stringContaining(`- 다음 확인: ${expectedNextLabel}`),
    );

    const secondState = getTaskById('task-watch-status');
    expect(secondState?.status_message_id).toBe('msg-123');
    expect(secondState?.status_started_at).toBe('2026-03-19T07:00:00.000Z');
  });
});

describe('watcher status message updates', () => {
  it('logs and falls back to sending a new watcher status message when edit fails', async () => {
    vi.setSystemTime(new Date('2026-03-19T07:00:00.000Z'));
    createTask({
      id: 'task-watch-status-edit-fail',
      group_folder: 'test-group',
      chat_jid: 'shared@g.us',
      agent_type: 'claude-code',
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
PR #77 checks

Check instructions:
Check the run.
      `.trim(),
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      status_message_id: 'msg-old',
      status_started_at: '2026-03-19T07:00:00.000Z',
      created_at: '2026-03-19T07:00:00.000Z',
    });

    const sendTrackedMessage = vi.fn(async () => 'msg-new');
    const editTrackedMessage = vi.fn(async () => {
      throw new Error('discord edit failed');
    });

    const tracker = createTaskStatusTracker(
      getTaskById('task-watch-status-edit-fail')!,
      {
        sendTrackedMessage,
        editTrackedMessage,
      },
    );

    await tracker.update('waiting', '2026-03-19T07:04:10.000Z');

    expect(loggerDebugMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-watch-status-edit-fail',
        chatJid: 'shared@g.us',
        statusMessageId: 'msg-old',
        phase: 'waiting',
      }),
      'Failed to edit watcher status message, falling back to send',
    );
    expect(sendTrackedMessage).toHaveBeenCalledWith(
      'shared@g.us',
      expect.stringContaining(`${TASK_STATUS_MESSAGE_PREFIX}CI 감시 중:`),
    );

    const updatedTask = getTaskById('task-watch-status-edit-fail');
    expect(updatedTask?.status_message_id).toBe('msg-new');
    expect(updatedTask?.status_started_at).toBe('2026-03-19T07:00:00.000Z');
  });

  it('edits the existing watcher status message when the watcher completes', async () => {
    vi.setSystemTime(new Date('2026-03-19T07:05:00.000Z'));
    createTask({
      id: 'task-watch-status-completed',
      group_folder: 'test-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
PR #77 checks

Check instructions:
Check the run.
      `.trim(),
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      status_message_id: 'msg-old',
      status_started_at: '2026-03-19T07:00:00.000Z',
      created_at: '2026-03-19T07:00:00.000Z',
    });

    const sendTrackedMessage = vi.fn(async () => 'msg-terminal');
    const editTrackedMessage = vi.fn(async () => {});

    const tracker = createTaskStatusTracker(
      getTaskById('task-watch-status-completed')!,
      {
        sendTrackedMessage,
        editTrackedMessage,
      },
    );

    await tracker.update('completed');

    expect(editTrackedMessage).toHaveBeenCalledWith(
      'shared@g.us',
      'msg-old',
      expect.stringContaining(`${TASK_STATUS_MESSAGE_PREFIX}CI 감시 종료:`),
    );
    expect(editTrackedMessage).toHaveBeenCalledWith(
      'shared@g.us',
      'msg-old',
      expect.stringContaining('- 상태: 완료'),
    );
    expect(sendTrackedMessage).not.toHaveBeenCalled();

    const updatedTask = getTaskById('task-watch-status-completed');
    expect(updatedTask?.status_message_id).toBe('msg-old');
    expect(updatedTask?.status_started_at).toBe('2026-03-19T07:00:00.000Z');
  });
});
