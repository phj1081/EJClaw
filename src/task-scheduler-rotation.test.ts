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

import { _initTestDatabase, createTask } from './db.js';
import * as codexTokenRotation from './codex-token-rotation.js';
import * as serviceRouting from './service-routing.js';
import * as tokenRefresh from './token-refresh.js';
import * as tokenRotation from './token-rotation.js';
import {
  _resetSchedulerLoopForTests,
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

describe('scheduled task Claude banner rotation', () => {
  it('suppresses Claude usage banners for scheduled tasks and retries with a rotated account', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-usage-banner',
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

    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(2);
    vi.mocked(tokenRotation.rotateToken).mockReturnValueOnce(true);

    (runAgentProcessMock as any)
      .mockImplementationOnce(
        async (
          _group: unknown,
          _input: unknown,
          _onProcess: unknown,
          onOutput?: (output: Record<string, unknown>) => Promise<void>,
        ) => {
          await onOutput?.({
            status: 'success',
            phase: 'intermediate',
            result: "You're out of extra usage · resets 4am (Asia/Seoul)",
          });
          await onOutput?.({
            status: 'success',
            result: "You're out of extra usage · resets 4am (Asia/Seoul)",
          });
          return {
            status: 'success',
            result: null,
          };
        },
      )
      .mockImplementationOnce(
        async (
          _group: unknown,
          _input: unknown,
          _onProcess: unknown,
          onOutput?: (output: Record<string, unknown>) => Promise<void>,
        ) => {
          await onOutput?.({
            status: 'success',
            result: 'rotated scheduled task response',
          });
          return {
            status: 'success',
            result: null,
          };
        },
      );

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );
    const sendMessage = vi.fn(async () => {});

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
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(runAgentProcessMock).toHaveBeenCalledTimes(2);
    expect(tokenRotation.rotateToken).toHaveBeenCalledTimes(1);
    expect(tokenRotation.markTokenHealthy).toHaveBeenCalledTimes(1);
    // No fallback cooldown to check
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'shared@g.us',
      'rotated scheduled task response',
    );
  });

  it('suppresses Claude OAuth expiry banners for scheduled tasks and retries with a rotated account', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-auth-expired-banner',
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

    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(2);
    vi.mocked(tokenRotation.rotateToken).mockReturnValueOnce(true);

    (runAgentProcessMock as any)
      .mockImplementationOnce(
        async (
          _group: unknown,
          _input: unknown,
          _onProcess: unknown,
          onOutput?: (output: Record<string, unknown>) => Promise<void>,
        ) => {
          await onOutput?.({
            status: 'success',
            phase: 'intermediate',
            result:
              'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
          });
          await onOutput?.({
            status: 'success',
            result:
              'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
          });
          return {
            status: 'success',
            result: null,
          };
        },
      )
      .mockImplementationOnce(
        async (
          _group: unknown,
          _input: unknown,
          _onProcess: unknown,
          onOutput?: (output: Record<string, unknown>) => Promise<void>,
        ) => {
          await onOutput?.({
            status: 'success',
            result: 'rotated scheduled task auth response',
          });
          return {
            status: 'success',
            result: null,
          };
        },
      );

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );
    const sendMessage = vi.fn(async () => {});

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
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(runAgentProcessMock).toHaveBeenCalledTimes(2);
    expect(tokenRotation.rotateToken).toHaveBeenCalledTimes(1);
    expect(tokenRotation.markTokenHealthy).toHaveBeenCalledTimes(1);
    // No fallback cooldown to check
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'shared@g.us',
      'rotated scheduled task auth response',
    );
  });
});

describe('scheduled task Claude error fallback', () => {
  it('suppresses Claude 502 HTML for scheduled tasks and falls back without forwarding it', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-claude-502-fallback',
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

    // Persistent 502: initial attempt + same-account transient retries all fail
    (runAgentProcessMock as any).mockImplementation(
      async (
        _group: unknown,
        _input: unknown,
        _onProcess: unknown,
        onOutput?: (output: Record<string, unknown>) => Promise<void>,
      ) => {
        await onOutput?.({
          status: 'success',
          phase: 'intermediate',
          result:
            'API Error: 502 <html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>cloudflare</center></body></html>',
        });
        await onOutput?.({
          status: 'success',
          result:
            'API Error: 502 <html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>cloudflare</center></body></html>',
        });
        return {
          status: 'success',
          result: null,
        };
      },
    );

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );
    const sendMessage = vi.fn(async () => {});

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
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    // 1 initial attempt + 2 same-account transient retries for 502/overloaded
    expect(runAgentProcessMock).toHaveBeenCalledTimes(3);
    expect(tokenRotation.rotateToken).not.toHaveBeenCalled();
    // No fallback — 502 results in error without retrying on another provider
  });

  it('suppresses Claude org access denied banners for scheduled tasks and retries with a rotated account', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-org-access-denied-banner',
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

    vi.mocked(tokenRotation.getTokenCount).mockReturnValue(2);
    vi.mocked(tokenRotation.rotateToken).mockReturnValueOnce(true);

    (runAgentProcessMock as any)
      .mockImplementationOnce(
        async (
          _group: unknown,
          _input: unknown,
          _onProcess: unknown,
          onOutput?: (output: Record<string, unknown>) => Promise<void>,
        ) => {
          await onOutput?.({
            status: 'success',
            phase: 'intermediate',
            result:
              'Your organization does not have access to Claude. Please login again or contact your administrator.',
          });
          await onOutput?.({
            status: 'success',
            result:
              'Your organization does not have access to Claude. Please login again or contact your administrator.',
          });
          return {
            status: 'success',
            result: null,
          };
        },
      )
      .mockImplementationOnce(
        async (
          _group: unknown,
          _input: unknown,
          _onProcess: unknown,
          onOutput?: (output: Record<string, unknown>) => Promise<void>,
        ) => {
          await onOutput?.({
            status: 'success',
            result: 'rotated scheduled task org-access response',
          });
          return {
            status: 'success',
            result: null,
          };
        },
      );

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );
    const sendMessage = vi.fn(async () => {});

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
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(runAgentProcessMock).toHaveBeenCalledTimes(2);
    expect(tokenRotation.rotateToken).toHaveBeenCalledTimes(1);
    expect(tokenRotation.markTokenHealthy).toHaveBeenCalledTimes(1);
    // No fallback cooldown to check
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'shared@g.us',
      'rotated scheduled task org-access response',
    );
  });
});

describe('scheduled task Codex rotation', () => {
  it('retries Codex scheduled tasks with a rotated account on streamed auth expiry', async () => {
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    createTask({
      id: 'task-codex-auth-expired',
      group_folder: 'shared-group',
      chat_jid: 'shared@g.us',
      agent_type: 'codex',
      prompt: 'codex task',
      schedule_type: 'once',
      schedule_value: dueAt,
      context_mode: 'isolated',
      next_run: dueAt,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    vi.mocked(codexTokenRotation.getCodexAccountCount).mockReturnValue(2);
    vi.mocked(codexTokenRotation.rotateCodexToken).mockReturnValueOnce(true);

    (runAgentProcessMock as any)
      .mockImplementationOnce(
        async (
          _group: unknown,
          _input: unknown,
          _onProcess: unknown,
          onOutput?: (output: Record<string, unknown>) => Promise<void>,
        ) => {
          await onOutput?.({
            status: 'error',
            error:
              'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}',
            result: null,
          });
          return {
            status: 'error',
            error:
              'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}',
            result: null,
          };
        },
      )
      .mockImplementationOnce(
        async (
          _group: unknown,
          _input: unknown,
          _onProcess: unknown,
          onOutput?: (output: Record<string, unknown>) => Promise<void>,
        ) => {
          await onOutput?.({
            status: 'success',
            result: 'rotated codex scheduled task response',
          });
          return {
            status: 'success',
            result: null,
          };
        },
      );

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );
    const sendMessage = vi.fn(async () => {});

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

    expect(runAgentProcessMock).toHaveBeenCalledTimes(2);
    expect(codexTokenRotation.rotateCodexToken).toHaveBeenCalledTimes(1);
    expect(codexTokenRotation.markCodexTokenHealthy).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'shared@g.us',
      'rotated codex scheduled task response',
    );
  });
});
