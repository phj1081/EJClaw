import { describe, expect, it } from 'vitest';

import type { StatusSnapshot } from './status-dashboard.js';
import type { ScheduledTask } from './types.js';
import { handleSimpleGetRoute } from './web-dashboard-routes.js';

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
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

describe('web dashboard simple routes', () => {
  const snapshots: StatusSnapshot[] = [
    {
      serviceId: 'codex-main',
      agentType: 'codex',
      assistantName: 'Codex',
      updatedAt: '2026-04-26T05:00:00.000Z',
      entries: [],
    },
  ];

  it('serves health, snapshots, and task JSON routes', async () => {
    const routeContext = {
      statusMaxAgeMs: 1234,
      readSnapshots: (maxAgeMs: number) => {
        expect(maxAgeMs).toBe(1234);
        return snapshots;
      },
      loadTasks: () => [makeTask()],
      jsonResponse,
    };

    const health = handleSimpleGetRoute({
      ...routeContext,
      url: new URL('http://localhost/api/health'),
    });
    expect(health?.status).toBe(200);
    await expect(health?.json()).resolves.toEqual({ ok: true });

    const status = handleSimpleGetRoute({
      ...routeContext,
      url: new URL('http://localhost/api/status-snapshots'),
    });
    expect(status?.status).toBe(200);
    await expect(status?.json()).resolves.toEqual(snapshots);

    const tasks = handleSimpleGetRoute({
      ...routeContext,
      url: new URL('http://localhost/api/tasks'),
    });
    expect(tasks?.status).toBe(200);
    await expect(tasks?.json()).resolves.toMatchObject([
      {
        id: 'task-1',
        groupFolder: 'general',
        promptPreview: 'regular scheduled task',
        status: 'active',
      },
    ]);
  });

  it('returns null for routes outside the simple table', () => {
    const result = handleSimpleGetRoute({
      url: new URL('http://localhost/api/overview'),
      statusMaxAgeMs: 1234,
      readSnapshots: () => [],
      loadTasks: () => [],
      jsonResponse,
    });

    expect(result).toBeNull();
  });
});
