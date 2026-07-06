import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _initTestDatabaseFromFile,
  getAllChats,
  getLatestMessageSeqAtOrBefore,
  getLastRespondingAgentType,
  getMessagesSinceSeq,
  getNewMessagesBySeq,
  getMessagesSince,
  getNewMessages,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { store } from '../test/helpers/db-test-utils.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('detects the most recent bot responder agent type', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'bot-1',
      chat_jid: 'group@g.us',
      sender: 'claude-main',
      sender_name: 'Claude',
      content: 'first bot reply',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_bot_message: true,
    });
    storeMessage({
      id: 'bot-2',
      chat_jid: 'group@g.us',
      sender: 'codex-review',
      sender_name: 'Codex',
      content: 'second bot reply',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_bot_message: true,
    });

    expect(getLastRespondingAgentType('group@g.us')).toBe('codex');
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('bot reply');
    expect(msgs[1].content).toBe('third');
  });

  it('includes bot messages from other senders', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(1);
    expect(botMsgs[0].is_bot_message).toBe(true);
  });

  it('returns all messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    expect(msgs).toHaveLength(4);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(4);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('bot reply');
    expect(messages[1].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

describe('message seq cursors', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'seq-1',
      chat_jid: 'group@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'seq-2',
      chat_jid: 'group@g.us',
      sender: 'bob',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    store({
      id: 'seq-3',
      chat_jid: 'group@g.us',
      sender: 'carol',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:03.000Z',
    });
  });

  it('assigns monotonic seq values and preserves them on upsert', () => {
    const { messages } = getNewMessagesBySeq(['group@g.us'], 0, 'Andy');
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);

    store({
      id: 'seq-2',
      chat_jid: 'group@g.us',
      sender: 'bob',
      sender_name: 'Bob',
      content: 'second updated',
      timestamp: '2024-01-01T00:00:02.500Z',
    });

    const afterUpdate = getMessagesSinceSeq('group@g.us', 0, 'Andy');
    expect(afterUpdate.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(afterUpdate[1].content).toBe('second updated');
  });

  it('maps legacy timestamp cursors to the latest seq at or before that time', () => {
    expect(
      getLatestMessageSeqAtOrBefore('2024-01-01T00:00:02.000Z', 'group@g.us'),
    ).toBe(2);
  });

  it('preserves legacy timestamp order when backfilling seq during init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-message-seq-order-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        is_from_me INTEGER NOT NULL DEFAULT 0,
        is_bot_message INTEGER NOT NULL DEFAULT 0,
        seq INTEGER
      );
    `);

    legacyDb
      .prepare(
        `INSERT INTO messages (
          id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, seq
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL)`,
      )
      .run(
        'legacy-late',
        'dc:legacy-seq',
        'user-1',
        'User One',
        'late insert',
        '2024-01-01T00:00:02.000Z',
      );
    legacyDb
      .prepare(
        `INSERT INTO messages (
          id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, seq
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL)`,
      )
      .run(
        'legacy-early',
        'dc:legacy-seq',
        'user-2',
        'User Two',
        'early insert',
        '2024-01-01T00:00:01.000Z',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(
      getMessagesSinceSeq('dc:legacy-seq', 0, 'Andy').map((message) => ({
        id: message.id,
        seq: message.seq,
      })),
    ).toEqual([
      { id: 'legacy-early', seq: 1 },
      { id: 'legacy-late', seq: 2 },
    ]);
  });

  it('backfills missing legacy seq values after the existing maximum without duplicates', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-message-seq-partial-');
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);

    legacyDb.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        is_from_me INTEGER NOT NULL DEFAULT 0,
        is_bot_message INTEGER NOT NULL DEFAULT 0,
        seq INTEGER
      );
    `);

    legacyDb
      .prepare(
        `INSERT INTO messages (
          id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, seq
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      )
      .run(
        'legacy-existing-seq',
        'dc:legacy-partial-seq',
        'user-1',
        'User One',
        'existing seq',
        '2024-01-01T00:00:01.000Z',
        1,
      );
    legacyDb
      .prepare(
        `INSERT INTO messages (
          id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, seq
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL)`,
      )
      .run(
        'legacy-missing-seq',
        'dc:legacy-partial-seq',
        'user-2',
        'User Two',
        'missing seq',
        '2024-01-01T00:00:00.500Z',
      );
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(
      getMessagesSinceSeq('dc:legacy-partial-seq', 0, 'Andy').map(
        (message) => ({
          id: message.id,
          seq: message.seq,
        }),
      ),
    ).toEqual([
      { id: 'legacy-existing-seq', seq: 1 },
      { id: 'legacy-missing-seq', seq: 2 },
    ]);
  });
});
