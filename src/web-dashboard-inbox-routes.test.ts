import { describe, expect, it } from 'vitest';

import type { NewMessage, PairedTask } from './types.js';
import {
  createInboxDismissTracker,
  handleInboxActionRoute,
  type InboxActionRouteDependencies,
} from './web-dashboard-inbox-routes.js';

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

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

function inboxRequest(
  inboxId: string,
  body: unknown,
  method = 'POST',
): Request {
  return new Request(
    `http://localhost/api/inbox/${encodeURIComponent(inboxId)}/actions`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    },
  );
}

function makeDeps(
  task: PairedTask | undefined,
  overrides: Partial<InboxActionRouteDependencies> = {},
): InboxActionRouteDependencies {
  return {
    dismissTracker: createInboxDismissTracker(),
    enqueueMessageCheck: () => undefined,
    loadPairedTaskById: (id) => (id === task?.id ? task : undefined),
    messageExists: () => false,
    mutatePairedTaskIfUnchanged: () => true,
    schedulePairedFollowUp: () => true,
    writeChatMetadata: () => undefined,
    writeMessage: () => undefined,
    ...overrides,
  };
}

describe('web dashboard inbox action routes', () => {
  it('tracks timestamped and global inbox dismissals separately', () => {
    const tracker = createInboxDismissTracker();

    tracker.dismiss('ci:task-1', '2026-04-26T05:00:00.000Z');
    expect(
      tracker.isDismissed({
        id: 'ci:task-1',
        lastOccurredAt: '2026-04-26T05:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      tracker.isDismissed({
        id: 'ci:task-1',
        lastOccurredAt: '2026-04-26T05:05:00.000Z',
      }),
    ).toBe(false);

    tracker.dismiss('ci:task-2', null);
    expect(
      tracker.isDismissed({
        id: 'ci:task-2',
        lastOccurredAt: '2026-04-26T05:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      tracker.isDismissed({
        id: 'ci:task-2',
        lastOccurredAt: '2026-04-26T05:05:00.000Z',
      }),
    ).toBe(true);
  });

  it('dismisses inbox items and queues paired follow-up intents', async () => {
    const dismissTracker = createInboxDismissTracker();
    const task = makePairedTask({ id: 'merge-1', status: 'merge_ready' });
    const scheduled: Array<{ taskId: string; intentKind: string }> = [];
    const queued: Array<{ chatJid: string; groupFolder: string }> = [];
    const deps = makeDeps(task, {
      dismissTracker,
      enqueueMessageCheck: (chatJid, groupFolder) => {
        queued.push({ chatJid, groupFolder });
      },
      schedulePairedFollowUp: (args) => {
        scheduled.push({
          taskId: args.task.id,
          intentKind: args.intentKind,
        });
        args.enqueue();
        return true;
      },
    });

    const fallThrough = await handleInboxActionRoute({
      ...deps,
      jsonResponse,
      request: new Request('http://localhost/api/overview'),
      url: new URL('http://localhost/api/overview'),
    });
    expect(fallThrough).toBeNull();

    const dismiss = await handleInboxActionRoute({
      ...deps,
      jsonResponse,
      request: inboxRequest('ci:task-1', {
        action: 'dismiss',
        lastOccurredAt: '2026-04-26T05:00:00.000Z',
      }),
      url: new URL('http://localhost/api/inbox/ci%3Atask-1/actions'),
    });
    expect(dismiss?.status).toBe(200);
    expect(
      dismissTracker.isDismissed({
        id: 'ci:task-1',
        lastOccurredAt: '2026-04-26T05:00:00.000Z',
      }),
    ).toBe(true);

    const run = await handleInboxActionRoute({
      ...deps,
      jsonResponse,
      request: inboxRequest('paired:merge-1:merge_ready', { action: 'run' }),
      url: new URL(
        'http://localhost/api/inbox/paired%3Amerge-1%3Amerge_ready/actions',
      ),
    });
    expect(run?.status).toBe(200);
    await expect(run?.json()).resolves.toMatchObject({
      intentKind: 'finalize-owner-turn',
      ok: true,
      queued: true,
      taskId: 'merge-1',
    });
    expect(scheduled).toEqual([
      { taskId: 'merge-1', intentKind: 'finalize-owner-turn' },
    ]);
    expect(queued).toEqual([{ chatJid: 'dc:general', groupFolder: 'general' }]);
  });

  it('declines paired tasks and rejects invalid inbox actions', async () => {
    const task = makePairedTask({
      id: 'arbiter-1',
      status: 'arbiter_requested',
      arbiter_requested_at: '2026-04-26T05:00:00.000Z',
    });
    const messages: NewMessage[] = [];
    const updates: unknown[] = [];
    const deps = makeDeps(task, {
      enqueueMessageCheck: () => undefined,
      messageExists: (chatJid, id) =>
        messages.some(
          (message) => message.chat_jid === chatJid && message.id === id,
        ),
      mutatePairedTaskIfUnchanged: (_id, _expectedUpdatedAt, update) => {
        updates.push(update);
        return true;
      },
      writeMessage: (message) => {
        messages.push(message);
      },
    });

    const decline = () =>
      handleInboxActionRoute({
        ...deps,
        jsonResponse,
        now: () => '2026-04-26T05:15:00.000Z',
        request: inboxRequest('paired:arbiter-1:arbiter_requested', {
          action: 'decline',
          requestId: 'decline 1',
        }),
        url: new URL(
          'http://localhost/api/inbox/paired%3Aarbiter-1%3Aarbiter_requested/actions',
        ),
      });

    const response = await decline();
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      queued: true,
      status: 'active',
      taskId: 'arbiter-1',
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      arbiter_requested_at: null,
      status: 'active',
      updated_at: '2026-04-26T05:15:00.000Z',
    });
    expect(messages[0]).toMatchObject({
      id: 'web-inbox-decline-1',
      content:
        'Dashboard declined arbiter escalation. Continue with the owner turn.',
      message_source_kind: 'ipc_injected_human',
    });

    const duplicate = await decline();
    expect(duplicate?.status).toBe(200);
    await expect(duplicate?.json()).resolves.toMatchObject({
      duplicate: true,
      queued: false,
    });
    expect(messages).toHaveLength(1);

    const invalidBody = await handleInboxActionRoute({
      ...deps,
      jsonResponse,
      request: inboxRequest('paired:arbiter-1:active', { action: 'approve' }),
      url: new URL(
        'http://localhost/api/inbox/paired%3Aarbiter-1%3Aactive/actions',
      ),
    });
    expect(invalidBody?.status).toBe(400);

    const stale = await handleInboxActionRoute({
      ...deps,
      jsonResponse,
      request: inboxRequest('paired:arbiter-1:merge_ready', { action: 'run' }),
      url: new URL(
        'http://localhost/api/inbox/paired%3Aarbiter-1%3Amerge_ready/actions',
      ),
    });
    expect(stale?.status).toBe(409);

    const notWired = await handleInboxActionRoute({
      ...deps,
      enqueueMessageCheck: undefined,
      jsonResponse,
      request: inboxRequest('paired:arbiter-1:active', { action: 'run' }),
      url: new URL(
        'http://localhost/api/inbox/paired%3Aarbiter-1%3Aactive/actions',
      ),
    });
    expect(notWired?.status).toBe(503);

    const wrongMethod = await handleInboxActionRoute({
      ...deps,
      jsonResponse,
      request: inboxRequest('paired:arbiter-1:active', null, 'GET'),
      url: new URL(
        'http://localhost/api/inbox/paired%3Aarbiter-1%3Aactive/actions',
      ),
    });
    expect(wrongMethod?.status).toBe(405);
  });
});
