import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StatusSnapshot } from './status-dashboard.js';
import type { PairedTask, ScheduledTask } from './types.js';
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
