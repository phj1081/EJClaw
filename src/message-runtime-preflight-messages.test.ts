import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', async () => {
  const actual = await vi.importActual<typeof import('./db.js')>('./db.js');
  return {
    ...actual,
    getMessagesSinceSeq: vi.fn(),
  };
});

import { _initTestDatabase, getMessagesSinceSeq } from './db.js';
import {
  getFreshHumanPreflightMessages,
  hasHumanMessageAfterWorkItem,
} from './message-runtime-preflight-messages.js';
import type { WorkItem } from './db/work-items.js';
import type { Channel, NewMessage } from './types.js';

function makeChannel(): Channel {
  return {
    name: 'discord-owner',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    disconnect: vi.fn(),
  } as unknown as Channel;
}

function makeMessage(overrides: Partial<NewMessage>): NewMessage {
  return {
    id: 'message-1',
    chat_jid: 'chat-1',
    sender: 'human@test',
    sender_name: 'human',
    content: 'hello',
    timestamp: '2026-04-29T01:00:00.000Z',
    seq: 1,
    ...overrides,
  };
}

function makeWorkItem(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: 1,
    group_folder: 'room',
    chat_jid: 'chat-1',
    agent_type: 'codex',
    service_id: 'codex-main',
    delivery_role: 'owner',
    start_seq: null,
    end_seq: null,
    result_payload: 'result',
    status: 'delivery_retry',
    last_error: null,
    delivery_attempts: 1,
    delivery_message_id: null,
    created_at: '2026-04-29T01:00:00.000Z',
    updated_at: '2026-04-29T01:00:00.000Z',
    delivered_at: null,
    ...overrides,
  };
}

describe('message-runtime-preflight-messages', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.mocked(getMessagesSinceSeq).mockReset();
  });

  it('loads messages from the last agent cursor and keeps only fresh human messages', () => {
    vi.mocked(getMessagesSinceSeq).mockReturnValue([
      makeMessage({ id: 'human', content: 'new human', seq: 11 }),
      makeMessage({
        id: 'self',
        content: 'self message',
        seq: 12,
        is_from_me: true,
      }),
      makeMessage({
        id: 'bot',
        content: 'bot message',
        seq: 13,
        is_bot_message: true,
      }),
    ]);

    const messages = getFreshHumanPreflightMessages({
      chatJid: 'chat-1',
      channel: makeChannel(),
      lastAgentTimestamps: { 'chat-1': '10' },
      assistantName: 'Andy',
      failureFinalText: 'failure',
    });

    expect(getMessagesSinceSeq).toHaveBeenCalledWith('chat-1', '10', 'Andy');
    expect(messages.map((message) => message.id)).toEqual(['human']);
  });

  it('detects human messages after a work item by sequence', () => {
    const workItem = makeWorkItem({ start_seq: 10, end_seq: 12 });

    expect(
      hasHumanMessageAfterWorkItem(workItem, [
        makeMessage({ id: 'old', seq: 12 }),
      ]),
    ).toBe(false);
    expect(
      hasHumanMessageAfterWorkItem(workItem, [
        makeMessage({ id: 'new', seq: 13 }),
      ]),
    ).toBe(true);
  });

  it('falls back to timestamps when sequence cursors are unavailable', () => {
    const workItem = makeWorkItem({
      start_seq: null,
      end_seq: null,
      updated_at: '2026-04-29T01:00:00.000Z',
    });

    expect(
      hasHumanMessageAfterWorkItem(workItem, [
        makeMessage({
          id: 'old',
          seq: undefined,
          timestamp: '2026-04-29T00:59:59.000Z',
        }),
      ]),
    ).toBe(false);
    expect(
      hasHumanMessageAfterWorkItem(workItem, [
        makeMessage({
          id: 'new',
          seq: undefined,
          timestamp: '2026-04-29T01:00:01.000Z',
        }),
      ]),
    ).toBe(true);
  });
});
