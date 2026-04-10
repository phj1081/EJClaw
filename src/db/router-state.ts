import { Database } from 'bun:sqlite';

import { normalizeServiceId } from '../config.js';
import { AgentType } from '../types.js';

export function getRouterStateFromDatabase(
  database: Database,
  key: string,
  currentServiceId: string,
): string | undefined {
  const row = database
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  if (row) return row.value;

  const prefixedKey = `${normalizeServiceId(currentServiceId)}:${key}`;
  const prefixedRow = database
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(prefixedKey) as { value: string } | undefined;
  if (!prefixedRow) return undefined;

  database
    .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
    .run(key, prefixedRow.value);
  database.prepare('DELETE FROM router_state WHERE key = ?').run(prefixedKey);
  return prefixedRow.value;
}

export function getRouterStateForServiceFromDatabase(
  database: Database,
  key: string,
  serviceId: string,
): string | undefined {
  const prefixedKey = `${normalizeServiceId(serviceId)}:${key}`;
  const row = database
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(prefixedKey) as { value: string } | undefined;
  if (row) return row.value;

  const canonical = database
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return canonical?.value;
}

export function setRouterStateInDatabase(
  database: Database,
  key: string,
  value: string,
): void {
  database
    .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
    .run(key, value);
}

export function setRouterStateForServiceInDatabase(
  database: Database,
  key: string,
  value: string,
  serviceId: string,
): void {
  const prefixedKey = `${normalizeServiceId(serviceId)}:${key}`;
  database
    .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
    .run(prefixedKey, value);
}

export function getLegacyRouterStateKeysFromDatabase(
  database: Database,
): string[] {
  const rows = database
    .prepare(
      `SELECT key
       FROM router_state
       WHERE key IN ('last_timestamp', 'last_agent_timestamp')
          OR key LIKE '%:last_timestamp'
          OR key LIKE '%:last_agent_timestamp'
       ORDER BY key`,
    )
    .all() as Array<{ key: string }>;

  return rows.map((row) => row.key);
}

export function getLastRespondingAgentTypeFromDatabase(
  database: Database,
  chatJid: string,
): AgentType | undefined {
  const row = database
    .prepare(
      `SELECT sender FROM messages
       WHERE chat_jid = ? AND is_bot_message = 1
       ORDER BY timestamp DESC, seq DESC
       LIMIT 1`,
    )
    .get(chatJid) as { sender: string } | undefined;

  if (!row) return undefined;

  const sender = row.sender.toLowerCase();
  if (sender.includes('claude')) return 'claude-code';
  if (sender.includes('codex')) return 'codex';
  return undefined;
}
