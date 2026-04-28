import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type {
  PairedTurnAttemptRecord,
  PairedTurnRecord,
  WorkItem,
} from './db.js';
import type { StatusSnapshot } from './status-dashboard.js';
import type { NewMessage, PairedTask, PairedTurnOutput } from './types.js';
import {
  handleRoomTimelineRoute,
  type RoomsTimelineRouteDependencies,
} from './web-dashboard-room-routes.js';

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

function makePairedTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'paired-room-1',
    chat_jid: 'dc:ops',
    group_folder: 'ops-room',
    owner_service_id: 'codex-main',
    reviewer_service_id: 'claude-reviewer',
    owner_agent_type: 'codex',
    reviewer_agent_type: 'claude-code',
    arbiter_agent_type: 'codex',
    title: 'Dashboard PR',
    source_ref: null,
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 2,
    owner_failure_count: 0,
    owner_step_done_streak: 0,
    finalize_step_done_count: 0,
    task_done_then_user_reopen_count: 0,
    empty_step_done_streak: 0,
    status: 'in_review',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-04-26T04:00:00.000Z',
    updated_at: '2026-04-26T05:20:00.000Z',
    ...overrides,
  };
}

function snapshot(updatedAt = '2026-04-26T05:22:00.000Z'): StatusSnapshot {
  return {
    serviceId: 'codex-main',
    agentType: 'codex',
    assistantName: 'Codex',
    updatedAt,
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
  };
}

function roomDeps(
  overrides: Partial<RoomsTimelineRouteDependencies> = {},
): RoomsTimelineRouteDependencies {
  return {
    statusMaxAgeMs: 1234,
    readSnapshots: () => [snapshot()],
    loadLatestPairedTaskForChat: () => null,
    loadPairedTurnsForTask: () => [],
    loadLatestPairedTurnForTask: () => null,
    loadPairedTurnAttempts: () => [],
    loadPairedTurnOutputs: () => [],
    loadRecentPairedTurnOutputsForChat: () => [],
    loadRecentDeliveredWorkItemsForChat: () => [],
    loadRecentChatMessages: () => [],
    ...overrides,
  };
}

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 9001,
    group_folder: 'ops-room',
    chat_jid: 'dc:ops',
    agent_type: 'codex',
    service_id: 'codex-main',
    delivery_role: 'owner',
    status: 'delivered',
    start_seq: null,
    end_seq: null,
    result_payload: 'owner final output',
    attachments: [],
    delivery_attempts: 1,
    delivery_message_id: 'discord-owner-final',
    last_error: null,
    created_at: '2026-04-26T05:18:00.000Z',
    updated_at: '2026-04-26T05:18:30.000Z',
    delivered_at: '2026-04-26T05:18:30.000Z',
    ...overrides,
  };
}

describe('web dashboard room routes', () => {
  it('serves room timeline with paired progress and recent messages', async () => {
    const pairedTask = makePairedTask();
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
        progress_text: 'checking current output',
        progress_updated_at: '2026-04-26T05:20:00.000Z',
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
    const requestedMessageLimits: number[] = [];
    const response = handleRoomTimelineRoute({
      url: new URL(
        `http://localhost/api/rooms/${encodeURIComponent('dc:ops')}/timeline`,
      ),
      request: new Request('http://localhost'),
      jsonResponse,
      ...roomDeps({
        loadLatestPairedTaskForChat: () => pairedTask,
        loadPairedTurnsForTask: () => turns,
        loadPairedTurnAttempts: () => attempts,
        loadPairedTurnOutputs: () => outputs,
        loadRecentDeliveredWorkItemsForChat: () => [workItem()],
        loadRecentChatMessages: (_jid, limit) => {
          requestedMessageLimits.push(limit ?? 20);
          return messages;
        },
      }),
    });

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      pairedTask: {
        currentTurn: { lastError: string; progressText: string };
        outputs: Array<{ outputText: string }>;
      };
      messages: Array<{ content: string; senderName: string }>;
    };
    expect(body.pairedTask.currentTurn).toMatchObject({
      lastError: 'OPENAI_API_KEY=<redacted>',
      progressText: 'checking current output',
    });
    expect(body.pairedTask.outputs).toEqual([]);
    expect(requestedMessageLimits).toEqual([8]);
    expect(body.messages).toEqual([
      expect.objectContaining({
        content: expect.stringContaining('BOT_TOKEN=<redacted>'),
        senderName: '눈쟁이',
      }),
      expect.objectContaining({
        content: 'owner final output',
        senderName: 'owner',
      }),
    ]);
    expect(body.messages[0]).toMatchObject({
      content: expect.stringContaining('BOT_TOKEN=<redacted>'),
      senderName: '눈쟁이',
    });
  });

  it('serves cached room timelines and falls through outside room routes', async () => {
    const pairedTask = makePairedTask({ id: 'paired-cache-1' });
    const response = handleRoomTimelineRoute({
      url: new URL('http://localhost/api/rooms-timeline'),
      request: new Request('http://localhost/api/rooms-timeline', {
        headers: { 'accept-encoding': 'gzip' },
      }),
      jsonResponse,
      ...roomDeps({
        readSnapshots: () => [snapshot('2026-04-26T06:22:00.000Z')],
        loadLatestPairedTaskForChat: () => pairedTask,
        loadLatestPairedTurnForTask: () => null,
        loadRecentChatMessages: () => [
          {
            id: 'msg-cache',
            chat_jid: 'dc:ops',
            sender: 'u1',
            sender_name: '눈쟁이',
            content: 'cache message',
            timestamp: '2026-04-26T06:17:00.000Z',
            is_from_me: false,
            is_bot_message: false,
            message_source_kind: 'human',
          },
        ],
      }),
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-encoding')).toBe('gzip');
    const bytes = new Uint8Array(await response!.arrayBuffer());
    const body = JSON.parse(
      new TextDecoder().decode(gunzipSync(bytes)),
    ) as Record<string, { pairedTask: { id: string } }>;
    expect(body['dc:ops']?.pairedTask.id).toBe('paired-cache-1');
    expect(
      handleRoomTimelineRoute({
        url: new URL('http://localhost/api/overview'),
        request: new Request('http://localhost/api/overview'),
        jsonResponse,
        ...roomDeps(),
      }),
    ).toBeNull();
  });
});
