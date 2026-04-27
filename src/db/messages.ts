import { Database } from 'bun:sqlite';

import {
  inferMessageSourceKindFromBotFlag,
  normalizeMessageSourceKind,
} from '../message-source.js';
import { NewMessage } from '../types.js';

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

function normalizeMessageRow(
  row: NewMessage & {
    is_from_me?: boolean | number;
    is_bot_message?: boolean | number;
    message_source_kind?: unknown;
  },
): NewMessage {
  const isBotMessage = !!row.is_bot_message;
  return {
    ...row,
    is_from_me: !!row.is_from_me,
    is_bot_message: isBotMessage,
    message_source_kind: normalizeMessageSourceKind(
      row.message_source_kind,
      inferMessageSourceKindFromBotFlag(isBotMessage),
    ),
  };
}

export function normalizeSeqCursor(
  cursor: string | number | null | undefined,
): number {
  if (typeof cursor === 'number') {
    return Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  }
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function storeChatMetadataInDatabase(
  database: Database,
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    database
      .prepare(
        `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
      )
      .run(chatJid, name, timestamp, ch, group);
  } else {
    database
      .prepare(
        `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
      )
      .run(chatJid, chatJid, timestamp, ch, group);
  }
}

export function getAllChatsFromDatabase(database: Database): ChatInfo[] {
  return database
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

export function hasMessageInDatabase(
  database: Database,
  chatJid: string,
  id: string,
): boolean {
  const row = database
    .prepare('SELECT 1 FROM messages WHERE chat_jid = ? AND id = ? LIMIT 1')
    .get(chatJid, id);
  return !!row;
}

export function storeMessageInDatabase(
  database: Database,
  msg: NewMessage,
): void {
  const nextSeq = () => {
    database.prepare('INSERT INTO message_sequence DEFAULT VALUES').run();
    return (
      database.prepare('SELECT last_insert_rowid() as id').get() as {
        id: number;
      }
    ).id;
  };

  database.transaction(() => {
    const existing = database
      .prepare('SELECT seq FROM messages WHERE id = ? AND chat_jid = ?')
      .get(msg.id, msg.chat_jid) as { seq: number | null } | undefined;
    const seq = existing?.seq ?? nextSeq();
    database
      .prepare(
        `INSERT INTO messages (
         id, chat_jid, sender, sender_name, content, timestamp, seq, is_from_me, is_bot_message, message_source_kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, chat_jid) DO UPDATE SET
         sender = excluded.sender,
         sender_name = excluded.sender_name,
         content = excluded.content,
         timestamp = excluded.timestamp,
         is_from_me = excluded.is_from_me,
         is_bot_message = excluded.is_bot_message,
         message_source_kind = excluded.message_source_kind`,
      )
      .run(
        msg.id,
        msg.chat_jid,
        msg.sender,
        msg.sender_name,
        msg.content,
        msg.timestamp,
        seq,
        msg.is_from_me ? 1 : 0,
        msg.is_bot_message ? 1 : 0,
        normalizeMessageSourceKind(
          msg.message_source_kind,
          inferMessageSourceKindFromBotFlag(msg.is_bot_message),
        ),
      );
  })();
}

export function getNewMessagesFromDatabase(
  database: Database,
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, message_source_kind
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = database
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as Array<
    NewMessage & {
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows.map(normalizeMessageRow), newTimestamp };
}

export function getMessagesSinceFromDatabase(
  database: Database,
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, message_source_kind
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const rows = database
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as Array<
    NewMessage & {
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;
  return rows.map(normalizeMessageRow);
}

export function getLatestMessageSeqAtOrBeforeFromDatabase(
  database: Database,
  timestamp: string,
  chatJid?: string,
): number {
  if (!timestamp) return 0;
  const row = (
    chatJid
      ? database
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) AS maxSeq
           FROM messages
           WHERE chat_jid = ? AND timestamp <= ?`,
          )
          .get(chatJid, timestamp)
      : database
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) AS maxSeq
           FROM messages
           WHERE timestamp <= ?`,
          )
          .get(timestamp)
  ) as { maxSeq: number | null };
  return row.maxSeq ?? 0;
}

export function getNewMessagesBySeqFromDatabase(
  database: Database,
  jids: string[],
  lastSeqCursor: string | number,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newSeqCursor: string } {
  const sinceSeq = normalizeSeqCursor(lastSeqCursor);
  if (jids.length === 0) {
    return { messages: [], newSeqCursor: String(sinceSeq) };
  }

  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, seq, is_from_me, is_bot_message, message_source_kind
    FROM messages
    WHERE seq > ? AND chat_jid IN (${placeholders})
      AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY seq
    LIMIT ?
  `;

  const rows = database
    .prepare(sql)
    .all(sinceSeq, ...jids, `${botPrefix}:%`, limit) as Array<
    NewMessage & {
      seq: number;
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;

  const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : sinceSeq;
  return {
    messages: rows.map(normalizeMessageRow),
    newSeqCursor: String(lastSeq),
  };
}

export function getMessagesSinceSeqFromDatabase(
  database: Database,
  chatJid: string,
  sinceSeqCursor: string | number,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  const sinceSeq = normalizeSeqCursor(sinceSeqCursor);
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, seq, is_from_me, is_bot_message, message_source_kind
    FROM messages
    WHERE chat_jid = ? AND seq > ?
      AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY seq
    LIMIT ?
  `;
  const rows = database
    .prepare(sql)
    .all(chatJid, sinceSeq, `${botPrefix}:%`, limit) as Array<
    NewMessage & {
      seq: number;
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;
  return rows.map(normalizeMessageRow);
}

const recentChatMessagesStmtCache = new WeakMap<
  Database,
  ReturnType<Database['prepare']>
>();

export function getRecentChatMessagesFromDatabase(
  database: Database,
  chatJid: string,
  limit: number = 20,
): NewMessage[] {
  let stmt = recentChatMessagesStmtCache.get(database);
  if (!stmt) {
    stmt = database.prepare(`
      SELECT * FROM (
        SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, message_source_kind
        FROM messages
        WHERE chat_jid = ?
          AND content != '' AND content IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ?
      ) ORDER BY timestamp
    `);
    recentChatMessagesStmtCache.set(database, stmt);
  }
  const rows = stmt.all(chatJid, limit) as Array<
    NewMessage & {
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;
  return rows.map(normalizeMessageRow);
}

export function getRecentChatMessagesBatchFromDatabase(
  database: Database,
  chatJids: string[],
  limit: number = 8,
): Map<string, NewMessage[]> {
  const out = new Map<string, NewMessage[]>();
  if (chatJids.length === 0) return out;
  const placeholders = chatJids.map(() => '?').join(',');
  const sql = `
    WITH ranked AS (
      SELECT id, chat_jid, sender, sender_name, content, timestamp,
             is_from_me, is_bot_message, message_source_kind,
             ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY timestamp DESC) AS rn
        FROM messages
       WHERE chat_jid IN (${placeholders})
         AND content != '' AND content IS NOT NULL
    )
    SELECT id, chat_jid, sender, sender_name, content, timestamp,
           is_from_me, is_bot_message, message_source_kind
      FROM ranked
     WHERE rn <= ?
     ORDER BY chat_jid, timestamp ASC
  `;
  const rows = database.prepare(sql).all(...chatJids, limit) as Array<
    NewMessage & {
      is_from_me?: boolean | number;
      is_bot_message?: boolean | number;
    }
  >;
  for (const row of rows) {
    const normalized = normalizeMessageRow(row);
    const existing = out.get(normalized.chat_jid);
    if (existing) existing.push(normalized);
    else out.set(normalized.chat_jid, [normalized]);
  }
  return out;
}

export function getLastHumanMessageTimestampFromDatabase(
  database: Database,
  chatJid: string,
): string | null {
  const row = database
    .prepare(
      `SELECT timestamp FROM messages
       WHERE chat_jid = ? AND is_bot_message = 0 AND is_from_me = 0
         AND content != '' AND content IS NOT NULL
       ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(chatJid) as { timestamp: string } | undefined;
  return row?.timestamp ?? null;
}

export function getLastHumanMessageSenderFromDatabase(
  database: Database,
  chatJid: string,
): string | null {
  const row = database
    .prepare(
      `SELECT sender FROM messages
       WHERE chat_jid = ? AND is_bot_message = 0 AND is_from_me = 0
         AND content != '' AND content IS NOT NULL
       ORDER BY timestamp DESC, seq DESC LIMIT 1`,
    )
    .get(chatJid) as { sender: string } | undefined;
  return row?.sender ?? null;
}

export function getLastHumanMessageContentFromDatabase(
  database: Database,
  chatJid: string,
): string | null {
  const row = database
    .prepare(
      `SELECT content FROM messages
       WHERE chat_jid = ? AND is_bot_message = 0 AND is_from_me = 0
         AND content != '' AND content IS NOT NULL
       ORDER BY timestamp DESC, seq DESC LIMIT 1`,
    )
    .get(chatJid) as { content: string } | undefined;
  return row?.content ?? null;
}

export function hasRecentRestartAnnouncementInDatabase(
  database: Database,
  chatJid: string,
  sinceTimestamp: string,
): boolean {
  const row = database
    .prepare(
      `SELECT 1 FROM messages
       WHERE chat_jid = ?
         AND timestamp >= ?
         AND is_bot_message = 1
         AND (
           content LIKE '재시작 완료.%'
           OR content LIKE '재시작 감지.%'
           OR content LIKE '서비스 재시작으로 이전 작업이 중단됐습니다.%'
         )
       LIMIT 1`,
    )
    .get(chatJid, sinceTimestamp) as { 1: number } | undefined;
  return !!row;
}
