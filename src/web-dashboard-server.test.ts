import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StatusSnapshot } from './status-dashboard.js';
import type { PairedTurnAttemptRecord, PairedTurnRecord } from './db.js';
import type {
  NewMessage,
  PairedTask,
  PairedTurnOutput,
  RegisteredGroup,
  ScheduledTask,
} from './types.js';
import { createWebDashboardHandler } from './web-dashboard-server.js';

const tempDirs: string[] = [];

function makeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'general',
    chat_jid: 'dc:general',
    agent_type: null,
    status_message_id: null,
    status_started_at: null,
    prompt: 'regular scheduled task',
    schedule_type: 'cron',
    schedule_value: '* * * * *',
    context_mode: 'group',
    next_run: '2026-04-26T05:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-04-26T04:00:00.000Z',
    ...overrides,
  };
}

function makePairedTask(overrides: Partial<PairedTask>): PairedTask {
  return {
    id: 'paired-1',
    chat_jid: 'dc:general',
    group_folder: 'general',
    owner_service_id: 'codex-main',
    reviewer_service_id: 'claude-reviewer',
    owner_agent_type: 'codex',
    reviewer_agent_type: 'claude-code',
    arbiter_agent_type: 'codex',
    title: 'Dashboard PR',
    source_ref: null,
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 0,
    owner_failure_count: 0,
    owner_step_done_streak: 0,
    finalize_step_done_count: 0,
    task_done_then_user_reopen_count: 0,
    empty_step_done_streak: 0,
    status: 'review_ready',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-04-26T04:00:00.000Z',
    updated_at: '2026-04-26T04:30:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('web dashboard server handler', () => {
  it('serves health and overview JSON without requiring Discord', async () => {
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
    });

    const health = await handler(new Request('http://localhost/api/health'));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });

    const overview = await handler(
      new Request('http://localhost/api/overview'),
    );
    expect(overview.status).toBe(200);
    const body = (await overview.json()) as {
      rooms: { total: number };
      tasks: { total: number };
      inbox: unknown[];
    };
    expect(body.rooms.total).toBe(0);
    expect(body.tasks.total).toBe(0);
    expect(body.inbox).toEqual([]);
  });

  it('serves full Claude, Kimi, and Codex usage rows through overview JSON', async () => {
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [
        {
          serviceId: 'renderer',
          agentType: 'claude-code',
          assistantName: 'Claude',
          updatedAt: '2026-04-26T11:59:00.000Z',
          entries: [],
          usageRowsFetchedAt: '2026-04-26T11:59:00.000Z',
          usageRows: [
            {
              name: 'Claude1 Max',
              h5pct: 66,
              h5reset: '2h',
              d7pct: 40,
              d7reset: '4d',
            },
            {
              name: 'Kimi',
              h5pct: 10,
              h5reset: '3h',
              d7pct: 12,
              d7reset: '5d',
            },
            {
              name: 'Codex1',
              h5pct: 25,
              h5reset: '55m',
              d7pct: 35,
              d7reset: '2d',
            },
          ],
        },
      ],
      getTasks: () => [],
      getPairedTasks: () => [],
    });

    const overview = await handler(
      new Request('http://localhost/api/overview'),
    );
    expect(overview.status).toBe(200);
    const body = (await overview.json()) as {
      usage: { rows: Array<{ name: string }> };
    };

    expect(body.usage.rows.map((row) => row.name)).toEqual([
      'Claude1 Max',
      'Kimi',
      'Codex1',
    ]);
  });

  it('serves typed inbox items through overview JSON', async () => {
    const snapshots: StatusSnapshot[] = [
      {
        serviceId: 'codex-main',
        agentType: 'codex',
        assistantName: 'Codex',
        updatedAt: '2026-04-26T05:00:00.000Z',
        entries: [
          {
            jid: 'dc:ops',
            name: '#ops',
            folder: 'ops',
            agentType: 'codex',
            status: 'waiting',
            elapsedMs: 2500,
            pendingMessages: true,
            pendingTasks: 1,
          },
        ],
      },
    ];

    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => snapshots,
      getTasks: () => [
        makeTask({
          id: 'ci-1',
          prompt:
            '[BACKGROUND CI WATCH]\nWatch target:\nPR #21\n\nCheck instructions:\nwatch',
          last_run: '2026-04-26T05:05:00.000Z',
          last_result: 'failed with API_KEY=plain-secret-value',
          status: 'paused',
        }),
      ],
      getPairedTasks: () => [
        makePairedTask({
          id: 'merge-1',
          status: 'merge_ready',
          title: 'Ready to merge',
          updated_at: '2026-04-26T05:04:00.000Z',
        }),
      ],
      now: () => '2026-04-26T05:10:00.000Z',
    });

    const overview = await handler(
      new Request('http://localhost/api/overview'),
    );
    expect(overview.status).toBe(200);
    const body = (await overview.json()) as {
      inbox: Array<{
        kind: string;
        id: string;
        summary: string;
        roomJid?: string;
        serviceId?: string;
        taskId?: string;
      }>;
    };

    expect(body.inbox.map((item) => item.kind)).toEqual([
      'ci-failure',
      'approval',
      'pending-room',
    ]);
    expect(body.inbox).toContainEqual(
      expect.objectContaining({
        kind: 'pending-room',
        id: 'room:codex-main:dc:ops',
        roomJid: 'dc:ops',
        serviceId: 'codex-main',
      }),
    );
    expect(body.inbox).toContainEqual(
      expect.objectContaining({
        kind: 'approval',
        id: 'paired:merge-1:merge_ready',
        taskId: 'merge-1',
        serviceId: 'codex-main',
      }),
    );
    const ciFailure = body.inbox.find((item) => item.kind === 'ci-failure');
    expect(ciFailure?.summary).toContain('API_KEY=<redacted>');
    expect(ciFailure?.summary).not.toContain('plain-secret-value');
  });

  it('dismisses inbox items until they change', async () => {
    const snapshots: StatusSnapshot[] = [
      {
        serviceId: 'codex-main',
        agentType: 'codex',
        assistantName: 'Codex',
        updatedAt: '2026-04-26T05:00:00.000Z',
        entries: [
          {
            jid: 'dc:ops',
            name: '#ops',
            folder: 'ops',
            agentType: 'codex',
            status: 'waiting',
            elapsedMs: 2500,
            pendingMessages: true,
            pendingTasks: 1,
          },
        ],
      },
    ];
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => snapshots,
      getTasks: () => [],
      getPairedTasks: () => [],
      now: () => '2026-04-26T05:10:00.000Z',
    });

    const firstOverview = await handler(
      new Request('http://localhost/api/overview'),
    );
    expect(firstOverview.status).toBe(200);
    const firstBody = (await firstOverview.json()) as {
      inbox: Array<{ id: string; lastOccurredAt: string }>;
    };
    expect(firstBody.inbox).toHaveLength(1);

    const dismiss = await handler(
      new Request(
        `http://localhost/api/inbox/${encodeURIComponent(firstBody.inbox[0]!.id)}/actions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'dismiss',
            lastOccurredAt: firstBody.inbox[0]!.lastOccurredAt,
            requestId: 'dismiss-1',
          }),
        },
      ),
    );
    expect(dismiss.status).toBe(200);

    const dismissedOverview = await handler(
      new Request('http://localhost/api/overview'),
    );
    expect(dismissedOverview.status).toBe(200);
    await expect(dismissedOverview.json()).resolves.toMatchObject({
      inbox: [],
    });

    snapshots[0] = {
      ...snapshots[0]!,
      updatedAt: '2026-04-26T05:01:00.000Z',
    };
    const changedOverview = await handler(
      new Request('http://localhost/api/overview'),
    );
    expect(changedOverview.status).toBe(200);
    const changedBody = (await changedOverview.json()) as { inbox: unknown[] };
    expect(changedBody.inbox).toHaveLength(1);
  });

  it('mutates scheduled tasks through explicit action endpoints', async () => {
    let task: ScheduledTask | undefined = makeTask({
      id: 'ci-watch-1',
      prompt: '[BACKGROUND CI WATCH]\nwatch',
    });
    const updates: Array<Partial<ScheduledTask>> = [];
    const deleted: string[] = [];
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => (task ? [task] : []),
      getTaskById: (id) => (task?.id === id ? task : undefined),
      updateTask: (id, update) => {
        expect(id).toBe('ci-watch-1');
        updates.push(update);
        task = task ? { ...task, ...update } : task;
      },
      deleteTask: (id) => {
        deleted.push(id);
        task = undefined;
      },
      getPairedTasks: () => [],
    });

    const pause = await handler(
      new Request('http://localhost/api/tasks/ci-watch-1/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pause' }),
      }),
    );
    expect(pause.status).toBe(200);
    await expect(pause.json()).resolves.toMatchObject({
      ok: true,
      task: { id: 'ci-watch-1', status: 'paused' },
    });
    expect(updates.at(-1)).toMatchObject({
      status: 'paused',
      suspended_until: null,
    });

    const resume = await handler(
      new Request('http://localhost/api/tasks/ci-watch-1/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resume' }),
      }),
    );
    expect(resume.status).toBe(200);
    await expect(resume.json()).resolves.toMatchObject({
      ok: true,
      task: { id: 'ci-watch-1', status: 'active' },
    });
    expect(updates.at(-1)).toMatchObject({
      status: 'active',
      suspended_until: null,
    });

    const cancel = await handler(
      new Request('http://localhost/api/tasks/ci-watch-1/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      }),
    );
    expect(cancel.status).toBe(200);
    await expect(cancel.json()).resolves.toEqual({
      ok: true,
      id: 'ci-watch-1',
      deleted: true,
    });
    expect(deleted).toEqual(['ci-watch-1']);
  });

  it('rejects invalid scheduled task actions', async () => {
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getTaskById: (id) =>
        id === 'task-1' ? makeTask({ id: 'task-1' }) : undefined,
      updateTask: () => {
        throw new Error('updateTask should not be called');
      },
      getPairedTasks: () => [],
    });

    const invalid = await handler(
      new Request('http://localhost/api/tasks/task-1/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restart-everything' }),
      }),
    );
    expect(invalid.status).toBe(400);

    const missing = await handler(
      new Request('http://localhost/api/tasks/missing/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pause' }),
      }),
    );
    expect(missing.status).toBe(404);

    const wrongMethod = await handler(
      new Request('http://localhost/api/tasks/task-1/actions', {
        method: 'GET',
      }),
    );
    expect(wrongMethod.status).toBe(405);
  });

  it('creates and edits scheduled tasks through web endpoints', async () => {
    const tasks = new Map<string, ScheduledTask>();
    const rooms: Record<string, RegisteredGroup> = {
      'dc:ops': {
        name: '#ops',
        folder: 'ops-room',
        added_at: '2026-04-26T05:00:00.000Z',
        agentType: 'codex',
      },
    };
    const nudges: string[] = [];
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [...tasks.values()],
      getTaskById: (id) => tasks.get(id),
      createTask: (task) => {
        tasks.set(task.id, {
          ...task,
          agent_type: task.agent_type ?? null,
          ci_provider: null,
          ci_metadata: null,
          max_duration_ms: null,
          status_message_id: null,
          status_started_at: null,
          last_run: null,
          last_result: null,
          suspended_until: null,
        });
      },
      updateTask: (id, updates) => {
        const task = tasks.get(id);
        if (task) tasks.set(id, { ...task, ...updates });
      },
      getPairedTasks: () => [],
      getRoomBindings: () => rooms,
      nudgeScheduler: () => {
        nudges.push('nudge');
      },
      now: () => '2026-04-26T05:10:00.000Z',
    });

    const create = await handler(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomJid: 'dc:ops',
          prompt: '  run hourly dashboard audit  ',
          requestId: 'task-create-1',
          scheduleType: 'once',
          scheduleValue: '2026-04-26T05:20:00.000Z',
          contextMode: 'group',
        }),
      }),
    );

    expect(create.status).toBe(200);
    const created = (await create.json()) as {
      task: { id: string; groupFolder: string; scheduleType: string };
    };
    expect(created.task.groupFolder).toBe('ops-room');
    expect(created.task.scheduleType).toBe('once');
    const createdTask = tasks.get(created.task.id);
    expect(createdTask).toMatchObject({
      agent_type: 'codex',
      chat_jid: 'dc:ops',
      context_mode: 'group',
      group_folder: 'ops-room',
      next_run: '2026-04-26T05:20:00.000Z',
      prompt: 'run hourly dashboard audit',
      schedule_type: 'once',
      status: 'active',
    });

    const duplicateCreate = await handler(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomJid: 'dc:ops',
          prompt: 'run hourly dashboard audit',
          requestId: 'task-create-1',
          scheduleType: 'once',
          scheduleValue: '2026-04-26T05:20:00.000Z',
          contextMode: 'group',
        }),
      }),
    );
    expect(duplicateCreate.status).toBe(200);
    await expect(duplicateCreate.json()).resolves.toMatchObject({
      duplicate: true,
      task: { id: created.task.id },
    });
    expect(tasks.size).toBe(1);

    tasks.set(created.task.id, {
      ...tasks.get(created.task.id)!,
      next_run: '2026-04-26T06:00:00.000Z',
      suspended_until: '2026-04-26T05:45:00.000Z',
    });
    const promptOnlyUpdate = await handler(
      new Request(`http://localhost/api/tasks/${created.task.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'watch dashboard with same schedule',
        }),
      }),
    );

    expect(promptOnlyUpdate.status).toBe(200);
    expect(tasks.get(created.task.id)).toMatchObject({
      next_run: '2026-04-26T06:00:00.000Z',
      prompt: 'watch dashboard with same schedule',
      schedule_type: 'once',
      suspended_until: '2026-04-26T05:45:00.000Z',
    });

    const update = await handler(
      new Request(`http://localhost/api/tasks/${created.task.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'watch dashboard every minute',
          scheduleType: 'interval',
          scheduleValue: '60000',
        }),
      }),
    );

    expect(update.status).toBe(200);
    expect(tasks.get(created.task.id)).toMatchObject({
      next_run: '2026-04-26T05:11:00.000Z',
      prompt: 'watch dashboard every minute',
      schedule_type: 'interval',
      schedule_value: '60000',
      suspended_until: null,
    });
    expect(nudges).toEqual([]);

    const longPrompt = await handler(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomJid: 'dc:ops',
          prompt: 'x'.repeat(8_100),
          requestId: 'task-create-long',
          scheduleType: 'once',
          scheduleValue: '2026-04-26T05:20:00.000Z',
          contextMode: 'isolated',
        }),
      }),
    );
    expect(longPrompt.status).toBe(200);
    const longCreated = (await longPrompt.json()) as {
      task: { id: string; promptLength: number };
    };
    expect(longCreated.task.promptLength).toBe(8_000);
    expect(tasks.get(longCreated.task.id)?.prompt).toHaveLength(8_000);
  });

  it('rejects invalid scheduled task create and edit requests', async () => {
    const completed = makeTask({
      id: 'completed-task',
      status: 'completed',
    });
    const active = makeTask({
      id: 'active-task',
      status: 'active',
    });
    const watch = makeTask({
      id: 'watch-task',
      prompt: '[BACKGROUND CI WATCH]\nwatch',
    });
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [completed, active, watch],
      getTaskById: (id) =>
        id === completed.id
          ? completed
          : id === active.id
            ? active
            : id === watch.id
              ? watch
              : undefined,
      createTask: () => {
        throw new Error('createTask should not be called');
      },
      updateTask: () => {
        throw new Error('updateTask should not be called');
      },
      getPairedTasks: () => [],
      getRoomBindings: () => ({
        'dc:ops': {
          name: '#ops',
          folder: 'ops-room',
          added_at: '2026-04-26T05:00:00.000Z',
        },
      }),
    });

    const missingBody = await handler(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'run' }),
      }),
    );
    expect(missingBody.status).toBe(400);

    const missingRoom = await handler(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomJid: 'dc:missing',
          prompt: 'run',
          scheduleType: 'once',
          scheduleValue: '2026-04-26T05:20:00.000Z',
          contextMode: 'isolated',
        }),
      }),
    );
    expect(missingRoom.status).toBe(404);

    const invalidCron = await handler(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomJid: 'dc:ops',
          prompt: 'run',
          scheduleType: 'cron',
          scheduleValue: 'not cron',
          contextMode: 'isolated',
        }),
      }),
    );
    expect(invalidCron.status).toBe(400);

    const completedEdit = await handler(
      new Request('http://localhost/api/tasks/completed-task', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'run again',
          scheduleType: 'once',
          scheduleValue: '2026-04-26T05:20:00.000Z',
        }),
      }),
    );
    expect(completedEdit.status).toBe(409);

    const watcherEdit = await handler(
      new Request('http://localhost/api/tasks/watch-task', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'run again',
          scheduleType: 'interval',
          scheduleValue: '60000',
        }),
      }),
    );
    expect(watcherEdit.status).toBe(409);

    const unsupportedEdit = await handler(
      new Request('http://localhost/api/tasks/active-task', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentType: 'codex',
          contextMode: 'group',
          prompt: 'run again',
          scheduleType: 'interval',
          scheduleValue: '60000',
        }),
      }),
    );
    expect(unsupportedEdit.status).toBe(400);
  });

  it('queues paired inbox actions through the paired follow-up scheduler', async () => {
    const pairedTasks = new Map<string, PairedTask>([
      [
        'review-1',
        makePairedTask({
          id: 'review-1',
          status: 'review_ready',
          updated_at: '2026-04-26T05:01:00.000Z',
        }),
      ],
      [
        'merge-1',
        makePairedTask({
          id: 'merge-1',
          status: 'merge_ready',
          updated_at: '2026-04-26T05:02:00.000Z',
        }),
      ],
      [
        'arbiter-1',
        makePairedTask({
          id: 'arbiter-1',
          status: 'arbiter_requested',
          updated_at: '2026-04-26T05:03:00.000Z',
        }),
      ],
    ]);
    const scheduled: Array<{
      chatJid: string;
      taskId: string;
      intentKind: string;
    }> = [];
    const queued: Array<{ chatJid: string; groupFolder: string }> = [];
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [...pairedTasks.values()],
      getPairedTaskById: (id) => pairedTasks.get(id),
      schedulePairedFollowUp: (args) => {
        scheduled.push({
          chatJid: args.chatJid,
          taskId: args.task.id,
          intentKind: args.intentKind,
        });
        args.enqueue();
        return true;
      },
      enqueueMessageCheck: (chatJid, groupFolder) => {
        queued.push({ chatJid, groupFolder });
      },
    });
    const run = (inboxId: string) =>
      handler(
        new Request(
          `http://localhost/api/inbox/${encodeURIComponent(inboxId)}/actions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'run' }),
          },
        ),
      );

    const reviewer = await run('paired:review-1:review_ready');
    const finalize = await run('paired:merge-1:merge_ready');
    const arbiter = await run('paired:arbiter-1:arbiter_requested');

    expect(reviewer.status).toBe(200);
    expect(finalize.status).toBe(200);
    expect(arbiter.status).toBe(200);
    await expect(reviewer.json()).resolves.toMatchObject({
      ok: true,
      taskId: 'review-1',
      intentKind: 'reviewer-turn',
      queued: true,
    });
    await expect(finalize.json()).resolves.toMatchObject({
      ok: true,
      taskId: 'merge-1',
      intentKind: 'finalize-owner-turn',
      queued: true,
    });
    await expect(arbiter.json()).resolves.toMatchObject({
      ok: true,
      taskId: 'arbiter-1',
      intentKind: 'arbiter-turn',
      queued: true,
    });
    expect(scheduled).toEqual([
      {
        chatJid: 'dc:general',
        taskId: 'review-1',
        intentKind: 'reviewer-turn',
      },
      {
        chatJid: 'dc:general',
        taskId: 'merge-1',
        intentKind: 'finalize-owner-turn',
      },
      {
        chatJid: 'dc:general',
        taskId: 'arbiter-1',
        intentKind: 'arbiter-turn',
      },
    ]);
    expect(queued).toEqual([
      { chatJid: 'dc:general', groupFolder: 'general' },
      { chatJid: 'dc:general', groupFolder: 'general' },
      { chatJid: 'dc:general', groupFolder: 'general' },
    ]);
  });

  it('declines paired inbox actions back to the owner queue', async () => {
    const pairedTasks = new Map<string, PairedTask>([
      [
        'merge-1',
        makePairedTask({
          id: 'merge-1',
          status: 'merge_ready',
          updated_at: '2026-04-26T05:02:00.000Z',
        }),
      ],
    ]);
    const messages: NewMessage[] = [];
    const metadata: Array<{
      chatJid: string;
      timestamp: string;
      channel?: string;
      isGroup?: boolean;
    }> = [];
    const queued: Array<{ chatJid: string; groupFolder: string }> = [];
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [...pairedTasks.values()],
      getPairedTaskById: (id) => pairedTasks.get(id),
      updatePairedTaskIfUnchanged: (id, expectedUpdatedAt, updates) => {
        const task = pairedTasks.get(id);
        if (!task || task.updated_at !== expectedUpdatedAt) return false;
        pairedTasks.set(id, { ...task, ...updates });
        return true;
      },
      schedulePairedFollowUp: () => {
        throw new Error('schedulePairedFollowUp should not be called');
      },
      storeChatMetadata: (chatJid, timestamp, _name, channel, isGroup) => {
        metadata.push({ chatJid, timestamp, channel, isGroup });
      },
      storeMessage: (message) => {
        messages.push(message);
      },
      hasMessage: (chatJid, id) =>
        messages.some(
          (message) => message.chat_jid === chatJid && message.id === id,
        ),
      enqueueMessageCheck: (chatJid, groupFolder) => {
        queued.push({ chatJid, groupFolder });
      },
      now: () => '2026-04-26T05:15:00.000Z',
    });
    const decline = () =>
      handler(
        new Request(
          'http://localhost/api/inbox/paired%3Amerge-1%3Amerge_ready/actions',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'decline',
              requestId: 'decline-merge-1',
            }),
          },
        ),
      );

    const response = await decline();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      taskId: 'merge-1',
      status: 'active',
      queued: true,
    });
    expect(pairedTasks.get('merge-1')).toMatchObject({
      status: 'active',
      updated_at: '2026-04-26T05:15:00.000Z',
    });
    expect(metadata).toEqual([
      {
        chatJid: 'dc:general',
        timestamp: '2026-04-26T05:15:00.000Z',
        channel: 'web-dashboard',
        isGroup: true,
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'web-inbox-decline-merge-1',
      chat_jid: 'dc:general',
      sender: 'web-dashboard',
      sender_name: 'Web Dashboard',
      content: 'Dashboard declined finalization. Continue with the owner turn.',
      timestamp: '2026-04-26T05:15:00.000Z',
      is_from_me: false,
      is_bot_message: false,
      message_source_kind: 'ipc_injected_human',
    });
    expect(queued).toEqual([{ chatJid: 'dc:general', groupFolder: 'general' }]);

    const duplicate = await decline();
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: true,
      duplicate: true,
      queued: false,
    });
    expect(messages).toHaveLength(1);
    expect(queued).toHaveLength(1);
  });

  it('rejects invalid paired inbox actions', async () => {
    const pairedTask = makePairedTask({
      id: 'paired-1',
      status: 'review_ready',
    });
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [pairedTask],
      getPairedTaskById: (id) =>
        id === pairedTask.id ? pairedTask : undefined,
      schedulePairedFollowUp: () => {
        throw new Error('schedulePairedFollowUp should not be called');
      },
      enqueueMessageCheck: () => undefined,
    });
    const post = (inboxId: string, body: unknown = { action: 'run' }) =>
      handler(
        new Request(
          `http://localhost/api/inbox/${encodeURIComponent(inboxId)}/actions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        ),
      );

    const invalidBody = await post('paired:paired-1:review_ready', {
      action: 'approve',
    });
    expect(invalidBody.status).toBe(400);

    const unsupportedTarget = await post('ci:task-1');
    expect(unsupportedTarget.status).toBe(400);

    const missingTask = await post('paired:missing:review_ready');
    expect(missingTask.status).toBe(404);

    const stale = await post('paired:paired-1:merge_ready');
    expect(stale.status).toBe(409);

    const completedHandler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      getPairedTaskById: () =>
        makePairedTask({ id: 'done-1', status: 'completed' }),
      schedulePairedFollowUp: () => {
        throw new Error('schedulePairedFollowUp should not be called');
      },
      enqueueMessageCheck: () => undefined,
    });
    const completed = await completedHandler(
      new Request(
        'http://localhost/api/inbox/paired%3Adone-1%3Acompleted/actions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'run' }),
        },
      ),
    );
    expect(completed.status).toBe(409);

    const wrongMethod = await handler(
      new Request(
        'http://localhost/api/inbox/paired%3Apaired-1%3Areview_ready/actions',
        {
          method: 'GET',
        },
      ),
    );
    expect(wrongMethod.status).toBe(405);

    const notWired = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      getPairedTaskById: () => pairedTask,
    });
    const noQueue = await notWired(
      new Request(
        'http://localhost/api/inbox/paired%3Apaired-1%3Areview_ready/actions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'run' }),
        },
      ),
    );
    expect(noQueue.status).toBe(503);
  });

  it('restarts the service stack through the health action endpoint', async () => {
    let restartCalls = 0;
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      restartServiceStack: () => {
        restartCalls += 1;
        return ['ejclaw'];
      },
      now: () => '2026-04-26T05:30:00.000Z',
    });
    const restart = () =>
      handler(
        new Request('http://localhost/api/services/stack/actions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'restart',
            requestId: 'stack-restart-1',
          }),
        }),
      );

    const response = await restart();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      restart: {
        id: 'web-restart-stack-restart-1',
        target: 'stack',
        requestedAt: '2026-04-26T05:30:00.000Z',
        completedAt: '2026-04-26T05:30:00.000Z',
        status: 'success',
        services: ['ejclaw'],
      },
    });
    expect(restartCalls).toBe(1);

    const duplicate = await restart();
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: true,
      duplicate: true,
      restart: {
        id: 'web-restart-stack-restart-1',
        status: 'success',
      },
    });
    expect(restartCalls).toBe(1);

    const overview = await handler(
      new Request('http://localhost/api/overview'),
    );
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toMatchObject({
      operations: {
        serviceRestarts: [
          {
            id: 'web-restart-stack-restart-1',
            status: 'success',
            services: ['ejclaw'],
          },
        ],
      },
    });
  });

  it('records failed service stack restarts', async () => {
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      restartServiceStack: () => {
        throw new Error('systemctl failed');
      },
      now: () => '2026-04-26T05:35:00.000Z',
    });

    const response = await handler(
      new Request('http://localhost/api/services/stack/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'restart',
          requestId: 'stack-restart-fail',
        }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: 'systemctl failed',
      restart: {
        id: 'web-restart-stack-restart-fail',
        target: 'stack',
        status: 'failed',
        error: 'systemctl failed',
      },
    });

    const overview = await handler(
      new Request('http://localhost/api/overview'),
    );
    await expect(overview.json()).resolves.toMatchObject({
      operations: {
        serviceRestarts: [
          {
            id: 'web-restart-stack-restart-fail',
            status: 'failed',
            error: 'systemctl failed',
          },
        ],
      },
    });
  });

  it('rejects invalid service restart requests', async () => {
    let restartCalls = 0;
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      restartServiceStack: () => {
        restartCalls += 1;
        return ['ejclaw'];
      },
    });

    const invalidAction = await handler(
      new Request('http://localhost/api/services/stack/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      }),
    );
    expect(invalidAction.status).toBe(400);

    const invalidTarget = await handler(
      new Request('http://localhost/api/services/ejclaw/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restart' }),
      }),
    );
    expect(invalidTarget.status).toBe(400);

    const wrongMethod = await handler(
      new Request('http://localhost/api/services/stack/actions', {
        method: 'GET',
      }),
    );
    expect(wrongMethod.status).toBe(405);
    expect(restartCalls).toBe(0);
  });

  it('injects room messages and queues room work from the web dashboard', async () => {
    const messages: NewMessage[] = [];
    const metadata: Array<{
      chatJid: string;
      timestamp: string;
      name?: string;
      channel?: string;
      isGroup?: boolean;
    }> = [];
    const queued: Array<{ chatJid: string; groupFolder: string }> = [];
    const rooms: Record<string, RegisteredGroup> = {
      'dc:ops': {
        name: '#ops',
        folder: 'ops-room',
        added_at: '2026-04-26T05:00:00.000Z',
      },
    };
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      getRoomBindings: () => rooms,
      storeChatMetadata: (chatJid, timestamp, name, channel, isGroup) => {
        metadata.push({ chatJid, timestamp, name, channel, isGroup });
      },
      storeMessage: (message) => {
        messages.push(message);
      },
      hasMessage: () => false,
      enqueueMessageCheck: (chatJid, groupFolder) => {
        queued.push({ chatJid, groupFolder });
      },
      now: () => '2026-04-26T05:10:00.000Z',
    });

    const response = await handler(
      new Request(
        `http://localhost/api/rooms/${encodeURIComponent('dc:ops')}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'room-compose-1',
            text: '  run a dashboard check  ',
          }),
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      queued: true,
    });
    expect(metadata).toEqual([
      {
        chatJid: 'dc:ops',
        timestamp: '2026-04-26T05:10:00.000Z',
        name: '#ops',
        channel: 'web-dashboard',
        isGroup: true,
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      chat_jid: 'dc:ops',
      sender: 'web-dashboard',
      sender_name: 'Web Dashboard',
      content: 'run a dashboard check',
      timestamp: '2026-04-26T05:10:00.000Z',
      is_from_me: false,
      is_bot_message: false,
      message_source_kind: 'ipc_injected_human',
    });
    expect(messages[0]?.id).toBe('web-room-compose-1');
    expect(queued).toEqual([{ chatJid: 'dc:ops', groupFolder: 'ops-room' }]);
  });

  it('deduplicates repeated room message request ids', async () => {
    const messages: NewMessage[] = [];
    const queued: Array<{ chatJid: string; groupFolder: string }> = [];
    const existing = new Set<string>();
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      getRoomBindings: () => ({
        'dc:ops': {
          name: '#ops',
          folder: 'ops-room',
          added_at: '2026-04-26T05:00:00.000Z',
        },
      }),
      storeChatMetadata: () => undefined,
      storeMessage: (message) => {
        messages.push(message);
        existing.add(`${message.chat_jid}:${message.id}`);
      },
      hasMessage: (chatJid, id) => existing.has(`${chatJid}:${id}`),
      enqueueMessageCheck: (chatJid, groupFolder) => {
        queued.push({ chatJid, groupFolder });
      },
    });
    const request = () =>
      new Request(
        `http://localhost/api/rooms/${encodeURIComponent('dc:ops')}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'same-submit',
            text: 'repeat me',
          }),
        },
      );

    const first = await handler(request());
    const second = await handler(request());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      id: 'web-same-submit',
      queued: true,
    });
    await expect(second.json()).resolves.toMatchObject({
      id: 'web-same-submit',
      queued: false,
      duplicate: true,
    });
    expect(messages).toHaveLength(1);
    expect(queued).toHaveLength(1);
  });

  it('deduplicates existing room message request ids after restart', async () => {
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      getRoomBindings: () => ({
        'dc:ops': {
          name: '#ops',
          folder: 'ops-room',
          added_at: '2026-04-26T05:00:00.000Z',
        },
      }),
      storeChatMetadata: () => {
        throw new Error('storeChatMetadata should not be called');
      },
      storeMessage: () => {
        throw new Error('storeMessage should not be called');
      },
      hasMessage: (chatJid, id) =>
        chatJid === 'dc:ops' && id === 'web-previous-submit',
      enqueueMessageCheck: () => {
        throw new Error('enqueueMessageCheck should not be called');
      },
    });

    const response = await handler(
      new Request(
        `http://localhost/api/rooms/${encodeURIComponent('dc:ops')}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId: 'previous-submit',
            text: 'repeat after restart',
          }),
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'web-previous-submit',
      queued: false,
      duplicate: true,
    });
  });

  it('rejects invalid room message requests', async () => {
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      getRoomBindings: () => ({
        'dc:ops': {
          name: '#ops',
          folder: 'ops-room',
          added_at: '2026-04-26T05:00:00.000Z',
        },
      }),
      storeMessage: () => {
        throw new Error('storeMessage should not be called');
      },
      enqueueMessageCheck: () => {
        throw new Error('enqueueMessageCheck should not be called');
      },
    });

    const empty = await handler(
      new Request(
        `http://localhost/api/rooms/${encodeURIComponent('dc:ops')}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: '  ' }),
        },
      ),
    );
    expect(empty.status).toBe(400);

    const missing = await handler(
      new Request(
        `http://localhost/api/rooms/${encodeURIComponent('dc:missing')}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hello' }),
        },
      ),
    );
    expect(missing.status).toBe(404);

    const wrongMethod = await handler(
      new Request(
        `http://localhost/api/rooms/${encodeURIComponent('dc:ops')}/messages`,
        {
          method: 'GET',
        },
      ),
    );
    expect(wrongMethod.status).toBe(405);
  });

  it('returns 503 when room message injection is not wired', async () => {
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
    });

    const response = await handler(
      new Request(
        `http://localhost/api/rooms/${encodeURIComponent('dc:ops')}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hello' }),
        },
      ),
    );

    expect(response.status).toBe(503);
  });

  it('serves room timeline with paired turn progress and recent messages', async () => {
    const pairedTask = makePairedTask({
      id: 'paired-room-1',
      chat_jid: 'dc:ops',
      group_folder: 'ops-room',
      status: 'in_review',
      round_trip_count: 2,
      updated_at: '2026-04-26T05:20:00.000Z',
    });
    const turns: PairedTurnRecord[] = [
      {
        turn_id: 'paired-room-1:reviewer-turn',
        task_id: pairedTask.id,
        task_updated_at: pairedTask.updated_at,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'queued',
        executor_service_id: null,
        executor_agent_type: null,
        attempt_no: 0,
        created_at: '2026-04-26T05:18:30.000Z',
        updated_at: '2026-04-26T05:21:00.000Z',
        completed_at: null,
        last_error: null,
      },
    ];
    const attempts: PairedTurnAttemptRecord[] = [
      {
        attempt_id: 'paired-room-1:reviewer-turn:attempt:2',
        parent_attempt_id: null,
        parent_handoff_id: null,
        continuation_handoff_id: null,
        turn_id: 'paired-room-1:reviewer-turn',
        task_id: pairedTask.id,
        task_updated_at: pairedTask.updated_at,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'running',
        executor_service_id: 'claude-reviewer',
        executor_agent_type: 'claude-code',
        active_run_id: 'run-reviewer-1',
        attempt_no: 2,
        created_at: '2026-04-26T05:19:00.000Z',
        updated_at: '2026-04-26T05:21:00.000Z',
        completed_at: null,
        last_error: 'OPENAI_API_KEY=plain-secret-value',
      },
    ];
    const outputs: PairedTurnOutput[] = [
      {
        id: 1,
        task_id: pairedTask.id,
        turn_number: 1,
        role: 'owner',
        output_text: 'owner final output',
        verdict: 'step_done',
        created_at: '2026-04-26T05:18:00.000Z',
      },
    ];
    const messages: NewMessage[] = [
      {
        id: 'msg-1',
        chat_jid: 'dc:ops',
        sender: 'u1',
        sender_name: '눈쟁이',
        content: '진행 어디까지야? BOT_TOKEN=plain-secret-value',
        timestamp: '2026-04-26T05:17:00.000Z',
        is_from_me: false,
        is_bot_message: false,
        message_source_kind: 'human',
      },
    ];
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [
        {
          serviceId: 'codex-main',
          agentType: 'codex',
          assistantName: 'Codex',
          updatedAt: '2026-04-26T05:22:00.000Z',
          entries: [
            {
              jid: 'dc:ops',
              name: '#ops',
              folder: 'ops-room',
              agentType: 'codex',
              status: 'processing',
              elapsedMs: 120_000,
              pendingMessages: true,
              pendingTasks: 1,
            },
          ],
        },
      ],
      getTasks: () => [],
      getPairedTasks: () => [pairedTask],
      getLatestPairedTaskForChat: () => pairedTask,
      getPairedTurnsForTask: (taskId) =>
        taskId === pairedTask.id ? turns : [],
      getPairedTurnAttempts: (turnId) =>
        turnId === turns[0]!.turn_id ? attempts : [],
      getPairedTurnOutputs: () => outputs,
      getRecentChatMessages: () => messages,
    });

    const response = await handler(
      new Request(
        `http://localhost/api/rooms/${encodeURIComponent('dc:ops')}/timeline`,
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      jid: string;
      pairedTask: {
        id: string;
        roundTripCount: number;
        currentTurn: {
          role: string;
          state: string;
          attemptNo: number;
          lastError: string;
        };
        outputs: Array<{ outputText: string; turnNumber: number }>;
      };
      messages: Array<{ content: string; senderName: string }>;
    };
    expect(body.jid).toBe('dc:ops');
    expect(body.pairedTask.id).toBe('paired-room-1');
    expect(body.pairedTask.roundTripCount).toBe(2);
    expect(body.pairedTask.currentTurn).toMatchObject({
      role: 'reviewer',
      state: 'running',
      attemptNo: 2,
      lastError: 'OPENAI_API_KEY=<redacted>',
    });
    expect(body.pairedTask.outputs).toMatchObject([
      { turnNumber: 1, outputText: 'owner final output' },
    ]);
    expect(body.messages[0]?.content).toContain('BOT_TOKEN=<redacted>');
    expect(body.messages[0]?.senderName).toBe('눈쟁이');
  });

  it('returns 404 for missing room timelines', async () => {
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
    });

    const response = await handler(
      new Request(
        `http://localhost/api/rooms/${encodeURIComponent('dc:missing')}/timeline`,
      ),
    );

    expect(response.status).toBe(404);
  });

  it('serves Vite static assets and falls back to index for SPA routes', async () => {
    const staticDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-dashboard-'),
    );
    tempDirs.push(staticDir);
    fs.writeFileSync(
      path.join(staticDir, 'index.html'),
      '<div id="root"></div>',
    );
    fs.mkdirSync(path.join(staticDir, 'assets'));
    fs.writeFileSync(
      path.join(staticDir, 'assets', 'app.js'),
      'console.log("ok")',
    );

    const handler = createWebDashboardHandler({
      staticDir,
      readStatusSnapshots: () => [],
      getTasks: () => [],
    });

    const asset = await handler(new Request('http://localhost/assets/app.js'));
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    await expect(asset.text()).resolves.toContain('console.log');

    const fallback = await handler(
      new Request('http://localhost/tasks/swarm_123'),
    );
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('content-type')).toContain('text/html');
    await expect(fallback.text()).resolves.toContain('root');
  });
});
