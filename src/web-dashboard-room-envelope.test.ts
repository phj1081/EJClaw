import { describe, expect, it } from 'vitest';

import type { NewMessage } from './types.js';
import { buildWebDashboardRoomActivity } from './web-dashboard-data.js';

describe('web dashboard room envelope rendering', () => {
  it('unwraps EJClaw structured envelopes in room messages', () => {
    const envelope = JSON.stringify({
      ejclaw: {
        visibility: 'public',
        text: 'PR #52 모바일/룸 parity 검증 스크린샷입니다.',
        verdict: 'done',
        attachments: [
          {
            path: '/tmp/ejclaw-room-mobile-list-390.png',
            name: 'room.png',
            mime: 'image/png',
          },
        ],
      },
    });
    const htmlEscapedEnvelope = envelope.replace(/"/g, '&quot;');
    const messages: NewMessage[] = [
      makeMessage('msg-json', envelope, 'owner'),
      makeMessage('msg-html-json', htmlEscapedEnvelope, 'reviewer'),
      makeMessage(
        'msg-silent',
        '{"ejclaw":{"visibility":"silent","verdict":"silent"}}',
        'arbiter',
      ),
    ];

    const activity = buildWebDashboardRoomActivity({
      serviceId: 'codex-main',
      entry: {
        jid: 'dc:ops',
        name: '#ops',
        folder: 'ops',
        agentType: 'codex',
        status: 'processing',
        elapsedMs: 15_000,
        pendingMessages: true,
        pendingTasks: 1,
      },
      pairedTask: null,
      turns: [],
      attempts: [],
      outputs: [],
      messages,
    });

    expect(activity.messages).toHaveLength(2);
    expect(activity.messages.map((message) => message.content)).toEqual([
      'PR #52 모바일/룸 parity 검증 스크린샷입니다.',
      'PR #52 모바일/룸 parity 검증 스크린샷입니다.',
    ]);
    expect(JSON.stringify(activity.messages)).not.toContain('"ejclaw"');
  });
});

function makeMessage(
  id: string,
  content: string,
  senderName: string,
): NewMessage {
  return {
    id,
    chat_jid: 'dc:ops',
    sender: senderName,
    sender_name: senderName,
    content,
    timestamp: '2026-04-26T05:29:00.000Z',
    is_from_me: false,
    is_bot_message: true,
    message_source_kind: 'bot',
  };
}
