import { describe, expect, it } from 'vitest';

import type { NewMessage, PairedTask, PairedTurnOutput } from './types.js';
import { buildWebDashboardRoomActivity } from './web-dashboard-data.js';

function makePairedTask(overrides: Partial<PairedTask>): PairedTask {
  return {
    id: 'paired-1',
    chat_jid: 'dc:ops',
    group_folder: 'ops',
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

const roomEntry = {
  jid: 'dc:ops',
  name: '#ops',
  folder: 'ops',
  agentType: 'codex' as const,
  status: 'inactive' as const,
  elapsedMs: null,
  pendingMessages: false,
  pendingTasks: 0,
};

describe('web dashboard attachment data', () => {
  it('normalizes structured EJClaw envelopes in room messages and outputs', () => {
    const task = makePairedTask({ id: 'paired-structured' });
    const structured = JSON.stringify({
      ejclaw: {
        visibility: 'public',
        text: '라벨 좌측 클리핑 회귀 수정했습니다.',
        verdict: 'done',
        attachments: [
          {
            path: '/tmp/bar-chart-label-fit-playwright.png',
            name: 'bar-chart-label-fit-playwright.png',
            mime: 'image/png',
          },
        ],
      },
    });
    const output: PairedTurnOutput = {
      id: 1,
      task_id: task.id,
      turn_number: 1,
      role: 'owner',
      output_text: structured,
      verdict: 'done',
      created_at: '2026-04-26T05:30:00.000Z',
    };
    const message: NewMessage = {
      id: 'msg-structured',
      chat_jid: 'dc:ops',
      sender: 'bot-1',
      sender_name: 'owner',
      content: structured,
      timestamp: '2026-04-26T05:31:00.000Z',
      is_from_me: true,
      is_bot_message: true,
      message_source_kind: 'bot',
    };

    const activity = buildWebDashboardRoomActivity({
      serviceId: 'codex-main',
      entry: roomEntry,
      pairedTask: task,
      turns: [],
      attempts: [],
      outputs: [output],
      messages: [message],
    });

    expect(activity.messages[0]).toMatchObject({
      content: '라벨 좌측 클리핑 회귀 수정했습니다.',
      attachments: [
        {
          path: '/tmp/bar-chart-label-fit-playwright.png',
          name: 'bar-chart-label-fit-playwright.png',
          mime: 'image/png',
        },
      ],
    });
    expect(activity.messages[0]?.content).not.toContain('"ejclaw"');
    expect(activity.pairedTask?.outputs[0]).toMatchObject({
      outputText: '라벨 좌측 클리핑 회귀 수정했습니다.',
      attachments: [
        {
          path: '/tmp/bar-chart-label-fit-playwright.png',
          name: 'bar-chart-label-fit-playwright.png',
          mime: 'image/png',
        },
      ],
    });
    expect(activity.pairedTask?.outputs[0]?.outputText).not.toContain(
      '"ejclaw"',
    );
  });

  it('turns legacy Discord image placeholders into dashboard attachments', () => {
    const message: NewMessage = {
      id: 'msg-image',
      chat_jid: 'dc:ops',
      sender: 'bot-1',
      sender_name: 'owner',
      content:
        '라벨 좌측 클리핑 회귀 수정했습니다.\n[Image: screenshot.png → /tmp/bar-chart-label-fit-playwright.png]',
      timestamp: '2026-04-26T05:31:00.000Z',
      is_from_me: true,
      is_bot_message: true,
      message_source_kind: 'bot',
    };

    const activity = buildWebDashboardRoomActivity({
      serviceId: 'codex-main',
      entry: roomEntry,
      pairedTask: null,
      turns: [],
      attempts: [],
      outputs: [],
      messages: [message],
    });

    expect(activity.messages[0]).toMatchObject({
      content: '라벨 좌측 클리핑 회귀 수정했습니다.',
      attachments: [
        {
          path: '/tmp/bar-chart-label-fit-playwright.png',
          name: 'bar-chart-label-fit-playwright.png',
        },
      ],
    });
  });

  it('turns markdown image output into dashboard attachments', () => {
    const message: NewMessage = {
      id: 'msg-markdown-image',
      chat_jid: 'dc:ops',
      sender: 'bot-1',
      sender_name: 'owner',
      content:
        '라벨 좌측 클리핑 회귀 수정했습니다.\n![screenshot](/tmp/bar-chart-label-fit-playwright.png)',
      timestamp: '2026-04-26T05:31:00.000Z',
      is_from_me: true,
      is_bot_message: true,
      message_source_kind: 'bot',
    };

    const activity = buildWebDashboardRoomActivity({
      serviceId: 'codex-main',
      entry: roomEntry,
      pairedTask: null,
      turns: [],
      attempts: [],
      outputs: [],
      messages: [message],
    });

    expect(activity.messages[0]).toMatchObject({
      content: '라벨 좌측 클리핑 회귀 수정했습니다.',
      attachments: [
        {
          path: '/tmp/bar-chart-label-fit-playwright.png',
          name: 'bar-chart-label-fit-playwright.png',
        },
      ],
    });
  });
});
