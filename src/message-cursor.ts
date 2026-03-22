import { getLatestMessageSeqAtOrBefore } from './db.js';

export function normalizeStoredSeqCursor(
  cursor: string | undefined,
  chatJid?: string,
): string {
  if (!cursor) return '0';
  if (/^\d+$/.test(cursor.trim())) return cursor.trim();
  return String(getLatestMessageSeqAtOrBefore(cursor, chatJid));
}
