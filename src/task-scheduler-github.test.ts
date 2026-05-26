import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkGitHubActionsRunMock } = vi.hoisted(() => ({
  checkGitHubActionsRunMock: vi.fn(),
}));

vi.mock('./github-ci.js', () => ({
  checkGitHubActionsRun: checkGitHubActionsRunMock,
  computeGitHubWatcherDelayMs: vi.fn(() => 15_000),
  MAX_GITHUB_CONSECUTIVE_ERRORS: 5,
  parseGitHubCiMetadata: vi.fn((raw: string | null | undefined) => {
    if (!raw) return null;
    return JSON.parse(raw);
  }),
  serializeGitHubCiMetadata: vi.fn((metadata: unknown) =>
    JSON.stringify(metadata),
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

import {
  _initTestDatabase,
  createPairedTask,
  createTask,
  getRecentChatMessages,
  getTaskById,
} from './db.js';
import { runGithubCiTask } from './task-scheduler-github.js';
import type { SchedulerDependencies } from './task-scheduler-types.js';
import type { ScheduledTask } from './types.js';

function buildSchedulerDeps(overrides: {
  sendMessage?: SchedulerDependencies['sendMessage'];
  enqueueMessageCheck?: (chatJid: string, ipcDir?: string) => void;
}): SchedulerDependencies {
  return {
    serviceAgentType: 'codex',
    roomBindings: () => ({}),
    getSessions: () => ({}),
    queue: {
      enqueueMessageCheck: overrides.enqueueMessageCheck ?? vi.fn(),
    } as any,
    onProcess: () => {},
    sendMessage: overrides.sendMessage ?? vi.fn(async () => {}),
  };
}

function createReviewReadyPairedTask(now: string): void {
  createPairedTask({
    id: 'paired-review-ready',
    chat_jid: 'shared@g.us',
    group_folder: 'shared-group',
    owner_service_id: 'codex-main',
    reviewer_service_id: 'claude-review',
    owner_agent_type: 'codex',
    reviewer_agent_type: 'claude-code',
    arbiter_agent_type: 'codex',
    title: null,
    source_ref: null,
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 1,
    owner_failure_count: 0,
    owner_step_done_streak: 0,
    finalize_step_done_count: 0,
    task_done_then_user_reopen_count: 0,
    empty_step_done_streak: 0,
    status: 'review_ready',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: now,
    updated_at: now,
  });
}

function createGithubWatcherTask(overrides: {
  id?: string;
  roomRole?: ScheduledTask['room_role'];
  now: string;
}): ScheduledTask {
  const taskId = overrides.id ?? 'task-github-owner-complete';
  createTask({
    id: taskId,
    group_folder: 'shared-group',
    chat_jid: 'shared@g.us',
    agent_type: 'codex',
    room_role: overrides.roomRole,
    ci_provider: 'github',
    ci_metadata: JSON.stringify({
      repo: 'owner/repo',
      run_id: 777777,
    }),
    prompt: `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 777777

Check instructions:
Managed by host-driven watcher.
    `.trim(),
    schedule_type: 'interval',
    schedule_value: '15000',
    context_mode: 'isolated',
    next_run: overrides.now,
    status: 'active',
    created_at: overrides.now,
  });
  return getTaskById(taskId)!;
}

describe('GitHub CI watcher scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    checkGitHubActionsRunMock.mockReset();
  });

  it('queues an owner turn after an owner CI watcher completes in a paired room', async () => {
    checkGitHubActionsRunMock.mockResolvedValueOnce({
      terminal: true,
      resultSummary: '성공: owner/repo run 777777',
      completionMessage: 'CI 완료: GitHub Actions run 777777\n판정: 성공',
    });
    const now = '2026-02-22T00:00:00.000Z';
    createReviewReadyPairedTask(now);
    const task = createGithubWatcherTask({ now, roomRole: 'owner' });
    const sendMessage = vi.fn(async () => {});
    const enqueueMessageCheck = vi.fn();

    await runGithubCiTask(
      task,
      buildSchedulerDeps({ sendMessage, enqueueMessageCheck }),
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'shared@g.us',
      'CI 완료: GitHub Actions run 777777\n판정: 성공',
    );
    expect(enqueueMessageCheck).toHaveBeenCalledWith(
      'shared@g.us',
      expect.stringContaining('shared-group'),
    );
    expect(getRecentChatMessages('shared@g.us', 5).at(-1)).toMatchObject({
      sender: 'ci-watcher',
      sender_name: 'CI watcher',
      is_bot_message: false,
      message_source_kind: 'trusted_external_bot',
      content:
        '[CI watcher completed]\nCI 완료: GitHub Actions run 777777\n판정: 성공',
    });
    expect(getTaskById(task.id)).toBeUndefined();
  });
});
