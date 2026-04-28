import { describe, expect, it } from 'vitest';

import type { RegisteredGroup, ScheduledTask } from './types.js';
import {
  handleScheduledTaskRoute,
  type ScheduledTaskRouteDependencies,
} from './web-dashboard-task-routes.js';

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

function request(
  pathname: string,
  method: string,
  body?: Record<string, unknown>,
): Request {
  return new Request(`http://localhost${pathname}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
  });
}

function makeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'ops-room',
    chat_jid: 'dc:ops',
    agent_type: null,
    status_message_id: null,
    status_started_at: null,
    prompt: 'regular scheduled task',
    schedule_type: 'once',
    schedule_value: '2026-04-26T05:20:00.000Z',
    context_mode: 'isolated',
    next_run: '2026-04-26T05:20:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    suspended_until: null,
    created_at: '2026-04-26T05:00:00.000Z',
    ...overrides,
  };
}

function makeDeps(
  tasks: Map<string, ScheduledTask>,
  overrides: Partial<ScheduledTaskRouteDependencies> = {},
): ScheduledTaskRouteDependencies {
  return {
    createScheduledTask: (task) => {
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
    loadTaskById: (id) => tasks.get(id),
    mutateTask: (id, updates) => {
      const task = tasks.get(id);
      if (task) tasks.set(id, { ...task, ...updates });
    },
    removeTask: (id) => {
      tasks.delete(id);
    },
    ...overrides,
  };
}

async function route({
  body,
  deps,
  method,
  now,
  pathname,
}: {
  body?: Record<string, unknown>;
  deps: ScheduledTaskRouteDependencies;
  method: string;
  now?: () => string;
  pathname: string;
}): Promise<Response | null> {
  return handleScheduledTaskRoute({
    url: new URL(`http://localhost${pathname}`),
    request: request(pathname, method, body),
    jsonResponse,
    now,
    ...deps,
  });
}

describe('web dashboard scheduled task routes', () => {
  it('creates scheduled tasks with room resolution and duplicate request ids', async () => {
    const tasks = new Map<string, ScheduledTask>();
    const rooms: Record<string, RegisteredGroup> = {
      'dc:ops': {
        name: '#ops',
        folder: 'ops-room',
        added_at: '2026-04-26T05:00:00.000Z',
        agentType: 'codex',
      },
    };
    let nudges = 0;
    const deps = makeDeps(tasks, {
      loadRoomBindings: () => rooms,
      nudgeScheduler: () => {
        nudges += 1;
      },
    });

    const create = await route({
      pathname: '/api/tasks',
      method: 'POST',
      body: {
        roomJid: 'dc:ops',
        prompt: '  run deployment audit  ',
        requestId: 'task-create-1',
        scheduleType: 'once',
        scheduleValue: '2026-04-26T05:10:00.000Z',
        contextMode: 'group',
      },
      deps,
      now: () => '2026-04-26T05:10:00.000Z',
    });

    expect(create?.status).toBe(200);
    await expect(create?.json()).resolves.toMatchObject({
      ok: true,
      task: {
        id: 'web-task-task-create-1',
        groupFolder: 'ops-room',
        chatJid: 'dc:ops',
        agentType: 'codex',
        promptLength: 20,
        scheduleType: 'once',
        status: 'active',
      },
    });
    expect(tasks.get('web-task-task-create-1')).toMatchObject({
      prompt: 'run deployment audit',
      next_run: '2026-04-26T05:10:00.000Z',
    });
    expect(nudges).toBe(1);

    const duplicate = await route({
      pathname: '/api/tasks',
      method: 'POST',
      body: {
        roomJid: 'dc:ops',
        prompt: 'run deployment audit',
        requestId: 'task-create-1',
        scheduleType: 'once',
        scheduleValue: '2026-04-26T05:10:00.000Z',
      },
      deps,
      now: () => '2026-04-26T05:10:00.000Z',
    });
    expect(duplicate?.status).toBe(200);
    await expect(duplicate?.json()).resolves.toMatchObject({
      ok: true,
      duplicate: true,
      task: { id: 'web-task-task-create-1' },
    });
    expect(tasks).toHaveLength(1);
    expect(nudges).toBe(1);
  });

  it('handles task actions, edits, invalid watchers, and fall-through', async () => {
    const tasks = new Map<string, ScheduledTask>([
      ['active-task', makeTask({ id: 'active-task' })],
      [
        'watch-task',
        makeTask({
          id: 'watch-task',
          prompt: '[BACKGROUND CI WATCH]\nwatch',
        }),
      ],
    ]);
    const deps = makeDeps(tasks);

    const pause = await route({
      pathname: '/api/tasks/active-task/actions',
      method: 'POST',
      body: { action: 'pause' },
      deps,
    });
    expect(pause?.status).toBe(200);
    await expect(pause?.json()).resolves.toMatchObject({
      ok: true,
      task: { id: 'active-task', status: 'paused' },
    });
    expect(tasks.get('active-task')).toMatchObject({
      status: 'paused',
      suspended_until: null,
    });

    const edit = await route({
      pathname: '/api/tasks/active-task',
      method: 'PATCH',
      body: {
        prompt: 'watch every minute',
        scheduleType: 'interval',
        scheduleValue: '60000',
      },
      deps,
      now: () => '2026-04-26T05:10:00.000Z',
    });
    expect(edit?.status).toBe(200);
    expect(tasks.get('active-task')).toMatchObject({
      next_run: '2026-04-26T05:11:00.000Z',
      prompt: 'watch every minute',
      schedule_type: 'interval',
      schedule_value: '60000',
      suspended_until: null,
    });

    const watcherEdit = await route({
      pathname: '/api/tasks/watch-task',
      method: 'PATCH',
      body: { prompt: 'run again' },
      deps,
    });
    expect(watcherEdit?.status).toBe(409);

    const wrongMethod = await route({
      pathname: '/api/tasks/active-task/actions',
      method: 'GET',
      deps,
    });
    expect(wrongMethod?.status).toBe(405);

    const unmatched = await route({
      pathname: '/api/overview',
      method: 'GET',
      deps,
    });
    expect(unmatched).toBeNull();
  });
});
