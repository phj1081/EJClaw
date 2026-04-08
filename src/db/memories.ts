import { Database } from 'bun:sqlite';

import { logger } from '../logger.js';

export type MemoryScopeKind = 'room' | 'user' | 'project' | 'global';
export type MemorySourceKind = 'compact' | 'explicit' | 'import' | 'system';

export interface MemoryRecord {
  id: number;
  scopeKind: MemoryScopeKind;
  scopeKey: string;
  content: string;
  keywords: string[];
  memoryKind: string | null;
  sourceKind: MemorySourceKind;
  sourceRef: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  archivedAt: string | null;
}

export interface RecallMemoryQuery {
  scopeKind: MemoryScopeKind;
  scopeKey: string;
  text?: string;
  keywords?: string[];
  limit?: number;
}

interface MemoryDatabaseRow {
  id: number;
  scope_kind: string;
  scope_key: string;
  content: string;
  keywords_json: string;
  memory_kind: string | null;
  source_kind: string;
  source_ref: string | null;
  created_at: string;
  last_used_at: string | null;
  archived_at: string | null;
}

const MEMORY_SCOPE_LIMITS: Record<MemoryScopeKind, number> = {
  room: 300,
  user: 100,
  project: 200,
  global: 100,
};
const COMPACT_MEMORY_TTL_DAYS = 30;

function normalizeMemoryKeywords(keywords?: string[]): string[] {
  if (!Array.isArray(keywords)) return [];
  return [
    ...new Set(
      keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

function parseMemoryKeywords(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return normalizeMemoryKeywords(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

function mapMemoryRow(row: MemoryDatabaseRow): MemoryRecord {
  return {
    id: row.id,
    scopeKind: row.scope_kind as MemoryScopeKind,
    scopeKey: row.scope_key,
    content: row.content,
    keywords: parseMemoryKeywords(row.keywords_json),
    memoryKind: row.memory_kind,
    sourceKind: row.source_kind as MemorySourceKind,
    sourceRef: row.source_ref,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    archivedAt: row.archived_at,
  };
}

function buildMemoryFtsQuery(query: RecallMemoryQuery): string | null {
  const tokens = normalizeMemoryKeywords([
    ...(query.text?.match(/[\p{L}\p{N}_:-]+/gu) ?? []),
    ...(query.keywords ?? []),
  ]);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}

function getMemoryRowsForScope(
  database: Database,
  scopeKind: MemoryScopeKind,
  scopeKey: string,
): MemoryDatabaseRow[] {
  return database
    .prepare(
      `SELECT *
       FROM memories
       WHERE scope_kind = ?
         AND scope_key = ?
         AND archived_at IS NULL
       ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC`,
    )
    .all(scopeKind, scopeKey) as MemoryDatabaseRow[];
}

function queryFtsRowOrder(
  database: Database,
  query: RecallMemoryQuery,
): Map<number, number> {
  const ftsQuery = buildMemoryFtsQuery(query);
  if (!ftsQuery) return new Map();
  try {
    const rows = database
      .prepare(
        `SELECT memories.id AS id
         FROM memories_fts
         JOIN memories ON memories.id = memories_fts.rowid
         WHERE memories_fts MATCH ?
           AND memories.scope_kind = ?
           AND memories.scope_key = ?
           AND memories.archived_at IS NULL
         ORDER BY bm25(memories_fts), memories.created_at DESC
         LIMIT ?`,
      )
      .all(
        ftsQuery,
        query.scopeKind,
        query.scopeKey,
        Math.max(25, (query.limit ?? 10) * 8),
      ) as Array<{ id: number }>;
    return new Map(rows.map((row, index) => [row.id, rows.length - index]));
  } catch (error) {
    logger.warn(
      { query, error },
      'Memory FTS query failed; falling back to scope-only recall',
    );
    return new Map();
  }
}

export function touchMemoriesInDatabase(
  database: Database,
  ids: number[],
): void {
  const uniqueIds = [
    ...new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
  ];
  if (uniqueIds.length === 0) return;
  const now = new Date().toISOString();
  const stmt = database.prepare(
    `UPDATE memories
     SET last_used_at = ?
     WHERE id = ?`,
  );
  const tx = database.transaction(() => {
    for (const id of uniqueIds) stmt.run(now, id);
  });
  tx();
}

export function archiveMemoryInDatabase(database: Database, id: number): void {
  database
    .prepare(
      `UPDATE memories
       SET archived_at = COALESCE(archived_at, ?)
       WHERE id = ?`,
    )
    .run(new Date().toISOString(), id);
}

function buildCompactMemoryExpiryCutoff(nowIso: string): string {
  return new Date(
    new Date(nowIso).getTime() - COMPACT_MEMORY_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

export function expireStaleMemoriesInDatabase(
  database: Database,
  args?: {
    scopeKind?: MemoryScopeKind;
    scopeKey?: string;
    now?: string;
  },
): number {
  const nowIso = args?.now ?? new Date().toISOString();
  const cutoff = buildCompactMemoryExpiryCutoff(nowIso);
  const scopeClause =
    args?.scopeKind && args?.scopeKey
      ? 'AND scope_kind = ? AND scope_key = ?'
      : '';
  const stmt = database.prepare(
    `UPDATE memories
     SET archived_at = COALESCE(archived_at, ?)
     WHERE archived_at IS NULL
       AND source_kind = 'compact'
       AND COALESCE(last_used_at, created_at) < ?
       ${scopeClause}`,
  );
  const result = (
    args?.scopeKind && args?.scopeKey
      ? stmt.run(nowIso, cutoff, args.scopeKind, args.scopeKey)
      : stmt.run(nowIso, cutoff)
  ) as { changes?: number };
  return result.changes ?? 0;
}

export function enforceMemoryBoundsInDatabase(
  database: Database,
  scopeKind: MemoryScopeKind,
  scopeKey: string,
): void {
  const limit = MEMORY_SCOPE_LIMITS[scopeKind];
  const rows = database
    .prepare(
      `SELECT id
       FROM memories
       WHERE scope_kind = ?
         AND scope_key = ?
         AND archived_at IS NULL
       ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC
       LIMIT -1 OFFSET ?`,
    )
    .all(scopeKind, scopeKey, limit) as Array<{ id: number }>;
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  const stmt = database.prepare(
    `UPDATE memories
     SET archived_at = ?
     WHERE id = ?`,
  );
  const tx = database.transaction(() => {
    for (const row of rows) stmt.run(now, row.id);
  });
  tx();
}

export function rememberMemoryInDatabase(
  database: Database,
  input: {
    scopeKind: MemoryScopeKind;
    scopeKey: string;
    content: string;
    keywords?: string[];
    memoryKind?: string | null;
    sourceKind: MemorySourceKind;
    sourceRef?: string | null;
  },
): number {
  const normalizedContent = input.content.trim();
  if (!normalizedContent) {
    throw new Error('Memory content cannot be empty');
  }
  const normalizedKeywords = normalizeMemoryKeywords(input.keywords);
  const createdAt = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO memories (
         scope_kind,
         scope_key,
         content,
         keywords_json,
         memory_kind,
         source_kind,
         source_ref,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.scopeKind,
      input.scopeKey,
      normalizedContent,
      JSON.stringify(normalizedKeywords),
      input.memoryKind ?? null,
      input.sourceKind,
      input.sourceRef ?? null,
      createdAt,
    );
  const row = database.prepare('SELECT last_insert_rowid() AS id').get() as {
    id: number;
  };
  expireStaleMemoriesInDatabase(database, {
    scopeKind: input.scopeKind,
    scopeKey: input.scopeKey,
  });
  enforceMemoryBoundsInDatabase(database, input.scopeKind, input.scopeKey);
  return row.id;
}

export function recallMemoriesFromDatabase(
  database: Database,
  query: RecallMemoryQuery,
): MemoryRecord[] {
  const limit = Math.max(1, query.limit ?? 6);
  expireStaleMemoriesInDatabase(database, {
    scopeKind: query.scopeKind,
    scopeKey: query.scopeKey,
  });
  const rows = getMemoryRowsForScope(database, query.scopeKind, query.scopeKey);
  if (rows.length === 0) return [];

  const exactKeywords = new Set(normalizeMemoryKeywords(query.keywords));
  const ftsOrder = queryFtsRowOrder(database, query);
  const useQueryScoring = exactKeywords.size > 0 || Boolean(query.text?.trim());

  const scored = rows
    .map((row, index) => {
      const keywords = parseMemoryKeywords(row.keywords_json);
      const exactMatches = keywords.filter((keyword) =>
        exactKeywords.has(keyword),
      ).length;
      const ftsScore = ftsOrder.get(row.id) ?? 0;
      const recencyScore = rows.length - index;
      return {
        row,
        matched: exactMatches > 0 || ftsScore > 0,
        score: exactMatches * 100 + ftsScore * 10 + recencyScore,
      };
    })
    .filter((entry) => (useQueryScoring ? entry.matched : true))
    .sort((a, b) => b.score - a.score || b.row.id - a.row.id)
    .slice(0, limit);

  const memories = scored.map((entry) => mapMemoryRow(entry.row));
  touchMemoriesInDatabase(
    database,
    memories.map((memory) => memory.id),
  );
  return memories;
}
