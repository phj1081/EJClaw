import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  extractWatchCiTarget,
  isWatchCiTask,
  renderWatchCiStatusMessage,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('only enqueues tasks owned by the current service agent type', async () => {
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
      registeredGroups: () => ({
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
    expect(enqueueTask.mock.calls[0][1]).toBe('task-codex');
  });

  it('renders watcher heartbeat messages with target and timing', () => {
    const prompt = `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 123456

Task ID:
task-123

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

    expect(rendered).toContain('CI 감시 중: GitHub Actions run 123456');
    expect(rendered).toContain('- 상태: 대기 중');
    expect(rendered).toContain('- 마지막 확인: 16시 02분 10초');
    expect(rendered).toContain('- 경과 시간: 2분 10초');
    expect(rendered).toContain('- 확인 간격: 1분');
    expect(rendered).toContain('- 다음 확인: 16시 04분 10초');
    expect(rendered).not.toContain('16:02:10');
    expect(rendered).not.toContain('16:04:10');
  });

  it('omits watcher elapsed time when tracking has not started yet', () => {
    const prompt = `
[BACKGROUND CI WATCH]

Watch target:
GitHub Actions run 123456

Task ID:
task-123

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
