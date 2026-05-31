import { Database } from 'bun:sqlite';

import { logger } from '../logger.js';
import { parseVisibleVerdict } from '../paired-verdict.js';
import {
  OutboundAttachment,
  PairedRoomRole,
  PairedTurnOutput,
} from '../types.js';
import {
  parseAttachmentPayload,
  serializeAttachmentPayload,
} from './work-items.js';

const MAX_TURN_OUTPUT_CHARS = 50_000;

function storedOutputText(outputText: string): string {
  if (outputText.length <= MAX_TURN_OUTPUT_CHARS) {
    return outputText;
  }

  const notice = `\n\n[Output truncated: ${outputText.length} > ${MAX_TURN_OUTPUT_CHARS} chars]`;
  return `${outputText.slice(0, MAX_TURN_OUTPUT_CHARS - notice.length)}${notice}`;
}

export function insertPairedTurnOutputInDatabase(
  database: Database,
  taskId: string,
  turnNumber: number,
  role: PairedRoomRole,
  outputText: string,
  options: {
    createdAt?: string;
    attachments?: OutboundAttachment[];
  } = {},
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
         (task_id, turn_number, role, output_text, attachment_payload, verdict, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      taskId,
      turnNumber,
      role,
      storedOutputText(outputText),
      serializeAttachmentPayload(options.attachments),
      parseVisibleVerdict(outputText),
      options.createdAt ?? new Date().toISOString(),
    );
}

type StoredPairedTurnOutputRow = PairedTurnOutput & {
  attachment_payload?: string | null;
};

function hydratePairedTurnOutputRow(
  row: StoredPairedTurnOutputRow,
): PairedTurnOutput {
  return {
    ...row,
    attachments: parseAttachmentPayload(row.attachment_payload, {
      table: 'paired_turn_outputs',
      rowId: row.id,
    }),
  };
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
    .all(taskId)
    .map((row) => hydratePairedTurnOutputRow(row as StoredPairedTurnOutputRow));
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
  const rows = stmt.all(chatJid, limit) as StoredPairedTurnOutputRow[];
  return rows.reverse().map(hydratePairedTurnOutputRow);
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
