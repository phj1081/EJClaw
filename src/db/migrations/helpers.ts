import { Database } from 'bun:sqlite';

function getTableColumns(database: Database, tableName: string): string[] {
  return (
    database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

export function tableHasColumn(
  database: Database,
  tableName: string,
  columnName: string,
): boolean {
  return getTableColumns(database, tableName).includes(columnName);
}

export function tryExecMigration(database: Database, sql: string): void {
  try {
    database.exec(sql);
  } catch {
    /* column already exists */
  }
}

export function backfillMessageSeq(database: Database): void {
  const rows = database
    .prepare(
      `SELECT rowid, seq
       FROM messages
       ORDER BY CASE WHEN seq IS NULL THEN 1 ELSE 0 END, seq, timestamp, rowid`,
    )
    .all() as Array<{ rowid: number; seq: number | null }>;
  if (rows.length === 0) {
    return;
  }

  let nextSeq = 1;
  const assignSeq = database.prepare(
    'UPDATE messages SET seq = ? WHERE rowid = ? AND seq IS NULL',
  );
  const tx = database.transaction(() => {
    for (const row of rows) {
      if (row.seq === null) {
        assignSeq.run(nextSeq, row.rowid);
      }
      nextSeq = Math.max(nextSeq, (row.seq ?? nextSeq) + 1);
    }
  });
  tx();

  const maxSeqRow = database
    .prepare('SELECT MAX(seq) AS maxSeq FROM messages')
    .get() as { maxSeq: number | null };
  const maxSeq = maxSeqRow.maxSeq ?? 0;
  if (maxSeq > 0) {
    database
      .prepare('INSERT OR IGNORE INTO message_sequence (id) VALUES (?)')
      .run(maxSeq);
  }
}

export { getTableColumns };
