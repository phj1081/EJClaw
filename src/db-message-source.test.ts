import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  _initTestDatabaseFromFile,
  getMessagesSinceSeq,
  getRecentChatMessages,
  storeChatMetadata,
  storeMessage,
} from './db.js';

describe('message_source_kind persistence', () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('persists explicit message source kind through store and read paths', () => {
    storeChatMetadata('room@g.us', '2026-04-24T00:00:00.000Z', 'Room');
    storeMessage({
      id: 'ipc-1',
      chat_jid: 'room@g.us',
      sender: 'hermes',
      sender_name: 'Hermes',
      content: 'wake up',
      timestamp: '2026-04-24T00:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
      message_source_kind: 'trusted_external_bot',
    });

    const [recent] = getRecentChatMessages('room@g.us', 1);
    expect(recent).toMatchObject({
      id: 'ipc-1',
      is_bot_message: false,
      message_source_kind: 'trusted_external_bot',
    });

    storeMessage({
      id: 'ipc-1',
      chat_jid: 'room@g.us',
      sender: 'hermes',
      sender_name: 'Hermes',
      content: 'updated',
      timestamp: '2026-04-24T00:00:02.000Z',
      is_from_me: false,
      is_bot_message: true,
      message_source_kind: 'ipc_injected_bot',
    });

    const [updated] = getMessagesSinceSeq('room@g.us', 0, 'EJClaw', 10);
    expect(updated).toMatchObject({
      id: 'ipc-1',
      content: 'updated',
      is_bot_message: true,
      message_source_kind: 'ipc_injected_bot',
    });
  });

  it('defaults missing message source kind from is_bot_message', () => {
    storeChatMetadata('room@g.us', '2026-04-24T00:00:00.000Z', 'Room');
    storeMessage({
      id: 'human-1',
      chat_jid: 'room@g.us',
      sender: 'user',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-04-24T00:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessage({
      id: 'bot-1',
      chat_jid: 'room@g.us',
      sender: 'bot',
      sender_name: 'Bot',
      content: 'done',
      timestamp: '2026-04-24T00:00:02.000Z',
      is_from_me: false,
      is_bot_message: true,
    });

    expect(getRecentChatMessages('room@g.us', 2)).toEqual([
      expect.objectContaining({ id: 'human-1', message_source_kind: 'human' }),
      expect.objectContaining({ id: 'bot-1', message_source_kind: 'bot' }),
    ]);
  });

  it('migrates legacy message tables and backfills source kind', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-msg-source-'));
    const dbPath = path.join(tempDir, 'messages.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_message_time TEXT,
        channel TEXT,
        is_group INTEGER DEFAULT 0
      );
      CREATE TABLE messages (
        id TEXT,
        chat_jid TEXT,
        sender TEXT,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT,
        seq INTEGER,
        is_from_me INTEGER,
        is_bot_message INTEGER DEFAULT 0,
        PRIMARY KEY (id, chat_jid)
      );
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO chats (jid, name, last_message_time, channel, is_group)
      VALUES ('room@g.us', 'Room', '2026-04-24T00:00:02.000Z', 'discord', 1);
      INSERT INTO messages (
        id, chat_jid, sender, sender_name, content, timestamp, seq, is_from_me, is_bot_message
      ) VALUES
        ('human-legacy', 'room@g.us', 'user', 'User', 'hello', '2026-04-24T00:00:01.000Z', 1, 0, 0),
        ('bot-legacy', 'room@g.us', 'bot', 'Bot', 'done', '2026-04-24T00:00:02.000Z', 2, 0, 1);
    `);
    const insertMigration = legacyDb.prepare(
      'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
    );
    for (let version = 1; version <= 12; version += 1) {
      insertMigration.run(version, `legacy-${version}`);
    }
    legacyDb.close();

    _initTestDatabaseFromFile(dbPath);

    expect(getRecentChatMessages('room@g.us', 2)).toEqual([
      expect.objectContaining({
        id: 'human-legacy',
        message_source_kind: 'human',
      }),
      expect.objectContaining({ id: 'bot-legacy', message_source_kind: 'bot' }),
    ]);
  });
});
