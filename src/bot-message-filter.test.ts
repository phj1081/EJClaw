import { describe, expect, it } from 'vitest';

import { filterProcessableMessages } from './bot-message-filter.js';
import { NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'dc:1',
    sender: 'user-1',
    sender_name: 'User',
    content: 'hello',
    timestamp: '2026-03-20T00:00:00.000Z',
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

const OWN_BOT_ID = 'my-bot-123';

describe('filterProcessableMessages', () => {
  it('filters bot-authored messages in normal rooms', () => {
    const result = filterProcessableMessages(
      [
        makeMsg({ id: 'human-1', content: 'human' }),
        makeMsg({
          id: 'bot-1',
          sender: 'bot-1',
          sender_name: 'Bot',
          content: 'status report',
          is_bot_message: true,
        }),
      ],
      false,
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('human-1');
  });

  it('keeps other bot messages in paired rooms', () => {
    const isOwn = (m: NewMessage) =>
      m.is_bot_message === true && m.sender === OWN_BOT_ID;
    const result = filterProcessableMessages(
      [
        makeMsg({ id: 'human-1', content: 'human' }),
        makeMsg({
          id: 'bot-1',
          sender: 'other-bot-456',
          sender_name: 'OtherBot',
          content: 'status report',
          is_bot_message: true,
        }),
      ],
      true,
      isOwn,
    );

    expect(result).toHaveLength(2);
  });

  it('filters own bot messages in paired rooms', () => {
    const isOwn = (m: NewMessage) =>
      m.is_bot_message === true && m.sender === OWN_BOT_ID;
    const result = filterProcessableMessages(
      [
        makeMsg({ id: 'human-1', content: 'human' }),
        makeMsg({
          id: 'own-1',
          sender: OWN_BOT_ID,
          sender_name: 'MyBot',
          content: 'my own output',
          is_bot_message: true,
        }),
        makeMsg({
          id: 'other-1',
          sender: 'other-bot-456',
          sender_name: 'OtherBot',
          content: 'partner response',
          is_bot_message: true,
        }),
      ],
      true,
      isOwn,
    );

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('human-1');
    expect(result[1].id).toBe('other-1');
  });

  it('keeps all bot messages in paired rooms without isOwnMessage', () => {
    const result = filterProcessableMessages(
      [
        makeMsg({ id: 'human-1', content: 'human' }),
        makeMsg({
          id: 'bot-1',
          sender: 'bot-1',
          sender_name: 'Bot',
          content: 'status report',
          is_bot_message: true,
        }),
      ],
      true,
    );

    expect(result).toHaveLength(2);
  });

  it('filters session command control bot messages in paired rooms', () => {
    const isOwn = (m: NewMessage) =>
      m.is_bot_message === true && m.sender === OWN_BOT_ID;
    const result = filterProcessableMessages(
      [
        makeMsg({ id: 'human-1', content: 'human' }),
        makeMsg({
          id: 'control-1',
          sender: 'other-bot-456',
          sender_name: 'OtherBot',
          content:
            'Current session cleared. The next message will start a new conversation.',
          is_bot_message: true,
        }),
        makeMsg({
          id: 'other-1',
          sender: 'other-bot-456',
          sender_name: 'OtherBot',
          content: 'partner response',
          is_bot_message: true,
        }),
      ],
      true,
      isOwn,
    );

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('human-1');
    expect(result[1].id).toBe('other-1');
  });

  it('filters paired execution status control bot messages in paired rooms', () => {
    const isOwn = (m: NewMessage) =>
      m.is_bot_message === true && m.sender === OWN_BOT_ID;
    const result = filterProcessableMessages(
      [
        makeMsg({ id: 'human-1', content: 'human' }),
        makeMsg({
          id: 'control-1',
          sender: 'other-bot-456',
          sender_name: 'OtherBot',
          content: '<@216851709744513024> ✅ 작업 완료.',
          is_bot_message: true,
        }),
        makeMsg({
          id: 'control-2',
          sender: 'other-bot-456',
          sender_name: 'OtherBot',
          content: '⚠️ 자동 해결 불가 — 확인이 필요합니다.',
          is_bot_message: true,
        }),
        makeMsg({
          id: 'other-1',
          sender: 'other-bot-456',
          sender_name: 'OtherBot',
          content: 'partner response',
          is_bot_message: true,
        }),
      ],
      true,
      isOwn,
    );

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('human-1');
    expect(result[1].id).toBe('other-1');
  });
});
