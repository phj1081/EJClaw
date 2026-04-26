import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StatusSnapshot } from './status-dashboard.js';
import type {
  NewMessage,
  PairedTask,
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
