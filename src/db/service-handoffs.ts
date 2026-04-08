import { Database } from 'bun:sqlite';

import {
  normalizeServiceId,
  SERVICE_ID,
  SERVICE_SESSION_SCOPE,
} from '../config.js';
import { resolveRoleServiceShadow } from '../role-service-shadow.js';
import { AgentType, PairedRoomRole } from '../types.js';
import {
  getLatestMessageSeqAtOrBeforeFromDatabase,
  normalizeSeqCursor,
} from './messages.js';
import { resolveStableRoomRoleAgentType } from './legacy-rebuilds.js';
import { normalizeStoredAgentType } from './room-registration.js';
import {
  getRouterStateFromDatabase,
  setRouterStateInDatabase,
} from './router-state.js';

export interface ServiceHandoff {
  id: number;
  chat_jid: string;
  group_folder: string;
  source_service_id: string;
  target_service_id: string;
  source_role: PairedRoomRole | null;
  source_agent_type?: AgentType | null;
  target_role: PairedRoomRole | null;
  target_agent_type: AgentType;
  prompt: string;
  status: 'pending' | 'claimed' | 'completed' | 'failed';
  start_seq: number | null;
  end_seq: number | null;
  reason: string | null;
  intended_role: PairedRoomRole | null;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  last_error: string | null;
}

export interface CreateServiceHandoffInput {
  chat_jid: string;
  group_folder: string;
  source_service_id?: string;
  target_service_id?: string;
  source_role?: PairedRoomRole | null;
  target_role?: PairedRoomRole | null;
  source_agent_type?: AgentType | null;
  target_agent_type: AgentType;
  prompt: string;
  start_seq?: number | null;
  end_seq?: number | null;
  reason?: string | null;
  intended_role?: PairedRoomRole | null;
}

export interface CompleteServiceHandoffCursorInput {
  id: number;
  chat_jid: string;
  cursor_key?: string;
  end_seq?: number | null;
}

interface StoredServiceHandoffRow extends Omit<
  ServiceHandoff,
  | 'source_service_id'
  | 'target_service_id'
  | 'source_agent_type'
  | 'target_agent_type'
> {
  source_agent_type?: string | null;
  target_agent_type: string;
}

function hydrateServiceHandoffRow(
  database: Database,
  row: StoredServiceHandoffRow,
): ServiceHandoff {
  const sourceAgentType =
    normalizeStoredAgentType(row.source_agent_type) ??
    (row.source_role
      ? resolveStableRoomRoleAgentType(database, {
          chatJid: row.chat_jid,
          groupFolder: row.group_folder,
          role: row.source_role,
        })
      : null);
  const targetAgentType =
    normalizeStoredAgentType(row.target_agent_type) ??
    (row.target_role
      ? resolveStableRoomRoleAgentType(database, {
          chatJid: row.chat_jid,
          groupFolder: row.group_folder,
          role: row.target_role,
        })
      : null) ??
    'claude-code';

  return {
    ...row,
    source_agent_type: sourceAgentType ?? null,
    target_agent_type: targetAgentType,
    source_service_id:
      row.source_role != null
        ? (resolveRoleServiceShadow(row.source_role, sourceAgentType) ??
          SERVICE_SESSION_SCOPE)
        : SERVICE_SESSION_SCOPE,
    target_service_id:
      row.target_role != null
        ? (resolveRoleServiceShadow(row.target_role, targetAgentType) ??
          SERVICE_SESSION_SCOPE)
        : SERVICE_SESSION_SCOPE,
  };
}

function getPendingServiceHandoffRows(
  database: Database,
): StoredServiceHandoffRow[] {
  return database
    .prepare(
      `SELECT *
       FROM service_handoffs
       WHERE status = 'pending'
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as StoredServiceHandoffRow[];
}

function normalizeStoredLastAgentSeqCursor(
  database: Database,
  cursor: string | number | null | undefined,
  chatJid: string,
): number {
  if (typeof cursor === 'number') {
    return Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  }
  if (!cursor) return 0;
  const trimmed = cursor.trim();
  if (/^\d+$/.test(trimmed)) {
    return normalizeSeqCursor(trimmed);
  }
  return getLatestMessageSeqAtOrBeforeFromDatabase(database, trimmed, chatJid);
}

function parseLastAgentSeqState(
  raw: string | undefined,
  serviceId: string,
): Record<string, string> {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid last_agent_seq JSON for ${serviceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid last_agent_seq JSON for ${serviceId}: not an object`,
    );
  }

  const cursors: Record<string, string> = {};
  for (const [chatJid, cursor] of Object.entries(parsed)) {
    if (typeof cursor === 'string' || typeof cursor === 'number') {
      cursors[chatJid] = String(cursor);
    }
  }
  return cursors;
}

export function createServiceHandoffInDatabase(
  database: Database,
  input: CreateServiceHandoffInput,
): ServiceHandoff {
  const sourceRole = input.source_role ?? input.intended_role ?? null;
  const targetRole = input.target_role ?? input.intended_role ?? null;
  const sourceAgentType =
    normalizeStoredAgentType(input.source_agent_type) ??
    (sourceRole
      ? resolveStableRoomRoleAgentType(database, {
          chatJid: input.chat_jid,
          groupFolder: input.group_folder,
          role: sourceRole,
        })
      : null);

  database
    .prepare(
      `INSERT INTO service_handoffs (
          chat_jid,
          group_folder,
          source_role,
          source_agent_type,
          target_role,
          target_agent_type,
          prompt,
          start_seq,
          end_seq,
          reason,
          intended_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.chat_jid,
      input.group_folder,
      sourceRole,
      sourceAgentType ?? null,
      targetRole,
      input.target_agent_type,
      input.prompt,
      input.start_seq ?? null,
      input.end_seq ?? null,
      input.reason ?? null,
      input.intended_role ?? null,
    );

  const lastId = (
    database.prepare('SELECT last_insert_rowid() as id').get() as { id: number }
  ).id;
  return hydrateServiceHandoffRow(
    database,
    database
      .prepare('SELECT * FROM service_handoffs WHERE id = ?')
      .get(lastId) as StoredServiceHandoffRow,
  );
}

export function getPendingServiceHandoffsFromDatabase(
  database: Database,
  targetServiceId: string = SERVICE_SESSION_SCOPE,
): ServiceHandoff[] {
  return getPendingServiceHandoffRows(database)
    .map((row) => hydrateServiceHandoffRow(database, row))
    .filter(
      (handoff) =>
        normalizeServiceId(handoff.target_service_id) ===
        normalizeServiceId(targetServiceId),
    );
}

export function getAllPendingServiceHandoffsFromDatabase(
  database: Database,
): ServiceHandoff[] {
  return getPendingServiceHandoffRows(database).map((row) =>
    hydrateServiceHandoffRow(database, row),
  );
}

export function claimServiceHandoffInDatabase(
  database: Database,
  id: number,
): boolean {
  database
    .prepare(
      `UPDATE service_handoffs
         SET status = 'claimed',
             claimed_at = datetime('now')
         WHERE id = ?
           AND status = 'pending'`,
    )
    .run(id);
  return (
    (database.prepare('SELECT changes() as c').get() as { c: number }).c > 0
  );
}

export function completeServiceHandoffInDatabase(
  database: Database,
  id: number,
): void {
  database
    .prepare(
      `UPDATE service_handoffs
       SET status = 'completed',
           completed_at = datetime('now'),
           last_error = NULL
       WHERE id = ?`,
    )
    .run(id);
}

export function failServiceHandoffInDatabase(
  database: Database,
  id: number,
  error: string,
): void {
  database
    .prepare(
      `UPDATE service_handoffs
       SET status = 'failed',
           completed_at = datetime('now'),
           last_error = ?
       WHERE id = ?`,
    )
    .run(error, id);
}

export function completeServiceHandoffAndAdvanceTargetCursorInDatabase(
  database: Database,
  input: CompleteServiceHandoffCursorInput,
): string | null {
  return database.transaction(() => {
    let appliedCursor: string | null = null;

    if (input.end_seq != null) {
      const cursorKey = input.cursor_key ?? input.chat_jid;
      const currentState = parseLastAgentSeqState(
        getRouterStateFromDatabase(database, 'last_agent_seq', SERVICE_ID),
        'last_agent_seq',
      );
      const existingSeq = normalizeStoredLastAgentSeqCursor(
        database,
        currentState[cursorKey],
        input.chat_jid,
      );
      currentState[cursorKey] = String(Math.max(existingSeq, input.end_seq));
      setRouterStateInDatabase(
        database,
        'last_agent_seq',
        JSON.stringify(currentState),
      );
      appliedCursor = currentState[cursorKey];
    }

    database
      .prepare(
        `UPDATE service_handoffs
         SET status = 'completed',
             completed_at = datetime('now'),
             last_error = NULL
         WHERE id = ?`,
      )
      .run(input.id);

    return appliedCursor;
  })();
}
