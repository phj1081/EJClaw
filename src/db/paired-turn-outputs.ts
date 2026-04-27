import { Database } from 'bun:sqlite';

import { logger } from '../logger.js';
import { parseVisibleVerdict } from '../paired-verdict.js';
import { PairedRoomRole, PairedTurnOutput } from '../types.js';

const MAX_TURN_OUTPUT_CHARS = 50_000;

export function insertPairedTurnOutputInDatabase(
  database: Database,
  taskId: string,
  turnNumber: number,
  role: PairedRoomRole,
  outputText: string,
  createdAt?: string,
): void {
  if (outputText.length > MAX_TURN_OUTPUT_CHARS) {
    logger.warn(
      {
        taskId,
        turnNumber,
        role,
        originalLen: outputText.length,
        maxLen: MAX_TURN_OUTPUT_CHARS,
      },
      'Paired turn output truncated — agent output exceeds storage limit',
    );
  }

  database
    .prepare(
      `INSERT OR REPLACE INTO paired_turn_outputs
         (task_id, turn_number, role, output_text, verdict, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      taskId,
      turnNumber,
      role,
      outputText.slice(0, MAX_TURN_OUTPUT_CHARS),
      parseVisibleVerdict(outputText),
      createdAt ?? new Date().toISOString(),
    );
}

export function getPairedTurnOutputsFromDatabase(
  database: Database,
  taskId: string,
): PairedTurnOutput[] {
  return database
    .prepare(
      `SELECT * FROM paired_turn_outputs
        WHERE task_id = ?
        ORDER BY turn_number ASC`,
    )
    .all(taskId) as PairedTurnOutput[];
}

const recentOutputsForChatStmtCache = new WeakMap<
  Database,
  ReturnType<Database['prepare']>
>();

export function getRecentPairedTurnOutputsForChatFromDatabase(
  database: Database,
  chatJid: string,
  limit: number = 8,
): PairedTurnOutput[] {
  let stmt = recentOutputsForChatStmtCache.get(database);
  if (!stmt) {
    stmt = database.prepare(`
      SELECT o.*
        FROM paired_turn_outputs o
        INNER JOIN paired_tasks t ON o.task_id = t.id
       WHERE t.chat_jid = ?
       ORDER BY o.created_at DESC
       LIMIT ?
    `);
    recentOutputsForChatStmtCache.set(database, stmt);
  }
  const rows = stmt.all(chatJid, limit) as PairedTurnOutput[];
  return rows.reverse();
}

export function getLatestTurnNumberFromDatabase(
  database: Database,
  taskId: string,
): number {
  const row = database
    .prepare(
      `SELECT MAX(turn_number) as max_turn
        FROM paired_turn_outputs
        WHERE task_id = ?`,
    )
    .get(taskId) as { max_turn: number | null } | undefined;
  return row?.max_turn ?? 0;
}
