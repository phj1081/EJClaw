import { describe, expect, it } from 'vitest';

import { buildSendMessageIpcPayload } from '../src/ipc-message.js';

describe('agent runner IPC message payload', () => {
  it('includes senderRole when provided', () => {
    expect(
      buildSendMessageIpcPayload({
        chatJid: 'dc:123',
        text: 'hello',
        sender: 'Reviewer',
        senderRole: 'reviewer',
        runId: 'run-reviewer-1',
        groupFolder: 'discord-review',
        timestamp: '2026-04-04T13:45:00.000Z',
      }),
    ).toEqual({
      type: 'message',
      chatJid: 'dc:123',
      text: 'hello',
      sender: 'Reviewer',
      senderRole: 'reviewer',
      runId: 'run-reviewer-1',
      groupFolder: 'discord-review',
      timestamp: '2026-04-04T13:45:00.000Z',
    });
  });

  it('omits empty senderRole values', () => {
    expect(
      buildSendMessageIpcPayload({
        chatJid: 'dc:123',
        text: 'hello',
        senderRole: '',
        groupFolder: 'discord-review',
        timestamp: '2026-04-04T13:45:00.000Z',
      }).senderRole,
    ).toBeUndefined();
  });

  it('normalizes structured EJClaw envelopes instead of leaking raw JSON', () => {
    expect(
      buildSendMessageIpcPayload({
        chatJid: 'dc:123',
        text: JSON.stringify({
          ejclaw: {
            visibility: 'public',
            text: '스크린샷입니다.',
            verdict: 'done',
            attachments: [
              {
                path: '/tmp/ejclaw-room-mobile-list-390.png',
                name: 'room.png',
                mime: 'image/png',
              },
            ],
          },
        }),
        groupFolder: 'discord-review',
        timestamp: '2026-04-04T13:45:00.000Z',
      }),
    ).toEqual({
      type: 'message',
      chatJid: 'dc:123',
      text: '스크린샷입니다.',
      groupFolder: 'discord-review',
      timestamp: '2026-04-04T13:45:00.000Z',
      attachments: [
        {
          path: '/tmp/ejclaw-room-mobile-list-390.png',
          name: 'room.png',
          mime: 'image/png',
        },
      ],
    });
  });

  it('normalizes status-prefixed EJClaw envelopes and preserves attachments', () => {
    expect(
      buildSendMessageIpcPayload({
        chatJid: 'dc:123',
        text: `TASK_DONE

\`\`\`json
{"ejclaw":{"visibility":"public","text":"첨부했습니다.","verdict":"done","attachments":[{"path":"/tmp/ejclaw-status.png","name":"status.png","mime":"image/png"}]}}
\`\`\``,
        groupFolder: 'discord-review',
        timestamp: '2026-04-04T13:45:00.000Z',
      }),
    ).toEqual({
      type: 'message',
      chatJid: 'dc:123',
      text: 'TASK_DONE\n\n첨부했습니다.',
      groupFolder: 'discord-review',
      timestamp: '2026-04-04T13:45:00.000Z',
      attachments: [
        {
          path: '/tmp/ejclaw-status.png',
          name: 'status.png',
          mime: 'image/png',
        },
      ],
    });
  });

  it('normalizes markdown image output and preserves attachments', () => {
    expect(
      buildSendMessageIpcPayload({
        chatJid: 'dc:123',
        text: `TASK_DONE

스크린샷입니다.
![screenshot](/tmp/ejclaw-markdown.png)`,
        groupFolder: 'discord-review',
        timestamp: '2026-04-04T13:45:00.000Z',
      }),
    ).toEqual({
      type: 'message',
      chatJid: 'dc:123',
      text: 'TASK_DONE\n\n스크린샷입니다.',
      groupFolder: 'discord-review',
      timestamp: '2026-04-04T13:45:00.000Z',
      attachments: [
        {
          path: '/tmp/ejclaw-markdown.png',
          name: 'ejclaw-markdown.png',
        },
      ],
    });
  });

  it('turns silent EJClaw envelopes into empty no-op messages', () => {
    expect(
      buildSendMessageIpcPayload({
        chatJid: 'dc:123',
        text: '{"ejclaw":{"visibility":"silent","verdict":"silent"}}',
        groupFolder: 'discord-review',
        timestamp: '2026-04-04T13:45:00.000Z',
      }).text,
    ).toBe('');
  });
});
