import { Database } from 'bun:sqlite';

import {
  normalizeServiceId,
  SERVICE_ID,
  SERVICE_SESSION_SCOPE,
} from '../config.js';
import {
  buildPairedTurnIdentity,
  type PairedTurnIdentity,
} from '../paired-turn-identity.js';
import { AgentType, PairedRoomRole } from '../types.js';
import { setPairedTurnAttemptContinuationHandoffIdInDatabase } from './paired-turn-attempts.js';
import {
  failPairedTurnInDatabase,
  markPairedTurnDelegatedInDatabase,
} from './paired-turns.js';
import {
  getLatestMessageSeqAtOrBeforeFromDatabase,
  normalizeSeqCursor,
} from './messages.js';
import {
  fillCanonicalServiceHandoffMetadata,
  readCanonicalServiceHandoffMetadata,
} from './canonical-role-metadata.js';
import {
  getRouterStateFromDatabase,
  setRouterStateInDatabase,
} from './router-state.js';

export interface ServiceHandoff {
  id: number;
  chat_jid: string;
  group_folder: string;
  paired_task_id?: string | null;
  paired_task_updated_at?: string | null;
  turn_id?: string | null;
  turn_attempt_id?: string | null;
  turn_attempt_no?: number | null;
  turn_intent_kind?: PairedTurnIdentity['intentKind'] | null;
  turn_role?: PairedRoomRole | null;
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
  paired_task_id?: string | null;
  paired_task_updated_at?: string | null;
  turn_id?: string | null;
  turn_attempt_id?: string | null;
  turn_intent_kind?: PairedTurnIdentity['intentKind'] | null;
  turn_role?: PairedRoomRole | null;
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
  source_service_id?: string | null;
  target_service_id?: string | null;
  source_agent_type?: string | null;
  target_agent_type: string;
}

function hydrateStoredTurnIdentity(
  row: Pick<
    StoredServiceHandoffRow,
    | 'paired_task_id'
    | 'paired_task_updated_at'
    | 'turn_id'
    | 'turn_intent_kind'
    | 'turn_role'
  >,
): PairedTurnIdentity | null {
  if (
    !row.paired_task_id ||
    !row.paired_task_updated_at ||
    !row.turn_intent_kind
  ) {
    return null;
  }

  return buildPairedTurnIdentity({
    taskId: row.paired_task_id,
    taskUpdatedAt: row.paired_task_updated_at,
    intentKind: row.turn_intent_kind,
    role: row.turn_role ?? undefined,
    turnId: row.turn_id ?? undefined,
  });
}

function hydrateServiceHandoffRow(
  row: StoredServiceHandoffRow,
): ServiceHandoff {
  const {
    sourceRole,
    targetRole,
    sourceAgentType,
    targetAgentType,
    sourceServiceId,
    targetServiceId,
  } = readCanonicalServiceHandoffMetadata({
    id: row.id,
    chat_jid: row.chat_jid,
    source_service_id: row.source_service_id,
    target_service_id: row.target_service_id,
    source_role: row.source_role,
    target_role: row.target_role,
    intended_role: row.intended_role,
    source_agent_type: row.source_agent_type,
    target_agent_type: row.target_agent_type,
  });
  const turnIdentity = hydrateStoredTurnIdentity(row);

  return {
    ...row,
    paired_task_id: turnIdentity?.taskId ?? row.paired_task_id ?? null,
    paired_task_updated_at:
      turnIdentity?.taskUpdatedAt ?? row.paired_task_updated_at ?? null,
    turn_id: turnIdentity?.turnId ?? row.turn_id ?? null,
    turn_attempt_id: row.turn_attempt_id ?? null,
    turn_attempt_no: row.turn_attempt_no ?? null,
    turn_intent_kind: turnIdentity?.intentKind ?? row.turn_intent_kind ?? null,
    turn_role: turnIdentity?.role ?? row.turn_role ?? null,
    source_role: sourceRole,
    target_role: targetRole,
    source_agent_type: sourceAgentType ?? null,
    target_agent_type: targetAgentType,
    source_service_id: sourceServiceId,
    target_service_id: targetServiceId,
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
  const turnIdentity =
    input.paired_task_id &&
    input.paired_task_updated_at &&
    input.turn_intent_kind
      ? buildPairedTurnIdentity({
          taskId: input.paired_task_id,
          taskUpdatedAt: input.paired_task_updated_at,
          intentKind: input.turn_intent_kind,
          role: input.turn_role ?? undefined,
          turnId: input.turn_id ?? undefined,
        })
      : null;
  const {
    sourceRole,
    targetRole,
    sourceAgentType,
    targetAgentType,
    sourceServiceId,
    targetServiceId,
  } = fillCanonicalServiceHandoffMetadata({
    id: 'new',
    chat_jid: input.chat_jid,
    source_service_id: input.source_service_id,
    target_service_id: input.target_service_id,
    source_role: input.source_role,
    target_role: input.target_role,
    intended_role: input.intended_role,
    source_agent_type: input.source_agent_type,
    target_agent_type: input.target_agent_type,
  });

  const currentAttempt = turnIdentity
    ? markPairedTurnDelegatedInDatabase(database, {
        turnIdentity,
        executorServiceId: targetServiceId,
        executorAgentType: targetAgentType,
      })
    : undefined;
  if (turnIdentity) {
    if (!currentAttempt) {
      throw new Error(
        `paired_turns(${turnIdentity.turnId}) did not materialize a delegated attempt row`,
      );
    }
  }
  const turnAttemptNo = currentAttempt?.attempt_no ?? null;
  const turnAttemptId = currentAttempt?.attempt_id ?? null;

  database
    .prepare(
      `INSERT INTO service_handoffs (
          chat_jid,
          group_folder,
          paired_task_id,
          paired_task_updated_at,
          turn_id,
          turn_attempt_id,
          turn_attempt_no,
          turn_intent_kind,
          turn_role,
          source_service_id,
          target_service_id,
          source_role,
          source_agent_type,
          target_role,
          target_agent_type,
          prompt,
          start_seq,
          end_seq,
          reason,
          intended_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.chat_jid,
      input.group_folder,
      turnIdentity?.taskId ?? null,
      turnIdentity?.taskUpdatedAt ?? null,
      turnIdentity?.turnId ?? null,
      turnAttemptId,
      turnAttemptNo,
      turnIdentity?.intentKind ?? null,
      turnIdentity?.role ?? null,
      sourceServiceId,
      targetServiceId,
      sourceRole,
      sourceAgentType ?? null,
      targetRole,
      targetAgentType,
      input.prompt,
      input.start_seq ?? null,
      input.end_seq ?? null,
      input.reason ?? null,
      input.intended_role ?? null,
    );

  const lastId = (
    database.prepare('SELECT last_insert_rowid() as id').get() as { id: number }
  ).id;
  if (turnIdentity && currentAttempt) {
    setPairedTurnAttemptContinuationHandoffIdInDatabase(database, {
      turnId: turnIdentity.turnId,
      attemptNo: currentAttempt.attempt_no,
      handoffId: lastId,
    });
  }
  return hydrateServiceHandoffRow(
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
    .map((row) => hydrateServiceHandoffRow(row))
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
    hydrateServiceHandoffRow(row),
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
  database.transaction(() => {
    const row = database
      .prepare('SELECT * FROM service_handoffs WHERE id = ?')
      .get(id) as StoredServiceHandoffRow | undefined;
    let turnIdentity: PairedTurnIdentity | null = null;
    if (row) {
      try {
        turnIdentity = hydrateStoredTurnIdentity(row);
      } catch {
        turnIdentity = null;
      }
    }

    database
      .prepare(
        `UPDATE service_handoffs
         SET status = 'failed',
             completed_at = datetime('now'),
             last_error = ?
         WHERE id = ?`,
      )
      .run(error, id);

    if (turnIdentity) {
      failPairedTurnInDatabase(database, {
        turnIdentity,
        error,
      });
    }
  })();
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
