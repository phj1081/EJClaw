import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { NewMessage, PairedTask, RegisteredGroup } from './types.js';
import { createWebDashboardHandler } from './web-dashboard-server.js';

const tempDirs: string[] = [];

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
      startBackgroundCacheRefresh: false,
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

  it('shares inbox dismiss state with overview JSON', async () => {
    const pairedTask = makePairedTask({
      chat_jid: 'dc:ops',
      group_folder: 'ops',
      id: 'merge-1',
      status: 'merge_ready',
      updated_at: '2026-04-26T05:00:00.000Z',
    });
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [pairedTask],
      now: () => '2026-04-26T05:10:00.000Z',
      startBackgroundCacheRefresh: false,
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
          }),
        },
      ),
    );
    expect(dismiss.status).toBe(200);

    const dismissedOverview = await handler(
      new Request('http://localhost/api/overview'),
    );
    await expect(dismissedOverview.json()).resolves.toMatchObject({
      inbox: [],
    });

    pairedTask.updated_at = '2026-04-26T05:01:00.000Z';
    const changedOverview = await handler(
      new Request('http://localhost/api/overview'),
    );
    const changedBody = (await changedOverview.json()) as { inbox: unknown[] };
    expect(changedBody.inbox).toHaveLength(1);
  });

  it('shares service restart records with overview JSON', async () => {
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
      startBackgroundCacheRefresh: false,
    });

    const restart = await handler(
      new Request('http://localhost/api/services/stack/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'restart',
          requestId: 'stack-restart-1',
        }),
      }),
    );
    expect(restart.status).toBe(200);
    expect(restartCalls).toBe(1);

    const overview = await handler(
      new Request('http://localhost/api/overview'),
    );
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

  it('wires room message injection dependencies', async () => {
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
      startBackgroundCacheRefresh: false,
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
      id: 'web-room-compose-1',
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
      sender_name: 'Web Dashboard',
      content: 'run a dashboard check',
      message_source_kind: 'ipc_injected_human',
    });
    expect(queued).toEqual([{ chatJid: 'dc:ops', groupFolder: 'ops-room' }]);
  });

  it('wires room timeline dependencies', async () => {
    const pairedTask = makePairedTask({
      id: 'paired-room-1',
      chat_jid: 'dc:ops',
      group_folder: 'ops-room',
      status: 'in_review',
      round_trip_count: 2,
      updated_at: '2026-04-26T05:20:00.000Z',
    });
    const messages: NewMessage[] = [
      {
        id: 'msg-1',
        chat_jid: 'dc:ops',
        sender: 'u1',
        sender_name: '눈쟁이',
        content: '진행 어디까지야?',
        timestamp: '2026-04-26T05:17:00.000Z',
        is_from_me: false,
        is_bot_message: false,
        message_source_kind: 'human',
      },
    ];
    const requestedMessageLimits: number[] = [];
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
      getPairedTurnsForTask: () => [],
      getPairedTurnAttempts: () => [],
      getPairedTurnOutputs: () => [],
      getRecentPairedTurnOutputsForChat: () => [],
      getRecentDeliveredWorkItemsForChat: () => [],
      getRecentChatMessages: (_jid, limit) => {
        requestedMessageLimits.push(limit ?? 20);
        return messages;
      },
      startBackgroundCacheRefresh: false,
    });
    const response = await handler(
      new Request(
        `http://localhost/api/rooms/${encodeURIComponent('dc:ops')}/timeline`,
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      jid: string;
      pairedTask: { id: string; roundTripCount: number };
      messages: Array<{ content: string; senderName: string }>;
    };
    expect(body.jid).toBe('dc:ops');
    expect(body.pairedTask).toMatchObject({
      id: 'paired-room-1',
      roundTripCount: 2,
    });
    expect(requestedMessageLimits).toEqual([8]);
    expect(body.messages).toMatchObject([
      { content: '진행 어디까지야?', senderName: '눈쟁이' },
    ]);
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
      startBackgroundCacheRefresh: false,
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
