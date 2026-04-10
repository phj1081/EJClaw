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
});
