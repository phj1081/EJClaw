import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkGitHubActionsRunMock, sendScheduledMessageMock } = vi.hoisted(
  () => ({
    checkGitHubActionsRunMock: vi.fn(),
    sendScheduledMessageMock: vi.fn(async () => {}),
  }),
);

vi.mock('./github-ci.js', () => ({
  checkGitHubActionsRun: checkGitHubActionsRunMock,
  computeGitHubWatcherDelayMs: vi.fn(() => 15_000),
  MAX_GITHUB_CONSECUTIVE_ERRORS: 5,
  parseGitHubCiMetadata: vi.fn((raw: string | null | undefined) =>
    raw ? JSON.parse(raw) : null,
  ),
  serializeGitHubCiMetadata: vi.fn((metadata: unknown) =>
    JSON.stringify(metadata),
  ),
}));

vi.mock('./task-scheduler-runtime.js', () => ({
  sendScheduledMessage: sendScheduledMessageMock,
}));

vi.mock('./task-status-tracker.js', () => ({
  createTaskStatusTracker: () => ({
    update: vi.fn(async () => {}),
  }),
}));

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import { runGithubCiTask } from './task-scheduler-github.js';

describe('GitHub watcher delivery identity', () => {
  beforeEach(() => {
    _initTestDatabase();
    checkGitHubActionsRunMock.mockReset();
    sendScheduledMessageMock.mockClear();
  });

  it('passes the scheduling agent type to completion delivery', async () => {
    checkGitHubActionsRunMock.mockResolvedValueOnce({
      terminal: true,
      resultSummary: '성공: owner/repo run 765432',
      completionMessage: 'CI 완료: GitHub Actions run 765432\n판정: 성공',
    });
    createTask({
      id: 'task-github-codex-paired-complete',
      group_folder: 'paired-group',
      chat_jid: 'paired@g.us',
      agent_type: 'codex',
      room_role: 'owner',
      ci_provider: 'github',
      ci_metadata: JSON.stringify({ repo: 'owner/repo', run_id: 765432 }),
      prompt: '[BACKGROUND CI WATCH]\nGitHub Actions run 765432',
      schedule_type: 'interval',
      schedule_value: '15000',
      context_mode: 'isolated',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const task = getTaskById('task-github-codex-paired-complete');
    expect(task).toBeDefined();
    const deps = { sendMessage: vi.fn(async () => {}) } as any;

    await runGithubCiTask(task!, deps);

    expect(sendScheduledMessageMock).toHaveBeenCalledWith(
      deps,
      'paired@g.us',
      'CI 완료: GitHub Actions run 765432\n판정: 성공',
      'owner',
    );
    expect(getTaskById('task-github-codex-paired-complete')).toBeUndefined();
  });
});
