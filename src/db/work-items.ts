import { Database } from 'bun:sqlite';

import { SERVICE_SESSION_SCOPE } from '../config.js';
import { inferRoleFromServiceShadow } from '../role-service-shadow.js';
import { AgentType, PairedRoomRole } from '../types.js';
import { resolveWorkItemServiceShadow } from './legacy-rebuilds.js';

export interface WorkItem {
  id: number;
  group_folder: string;
  chat_jid: string;
  agent_type: AgentType;
  service_id: string;
  delivery_role?: PairedRoomRole | null;
  status: 'produced' | 'delivery_retry' | 'delivered';
  start_seq: number | null;
  end_seq: number | null;
  result_payload: string;
  delivery_attempts: number;
  delivery_message_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

interface StoredWorkItemRow extends Omit<
  WorkItem,
  'service_id' | 'agent_type'
> {
  agent_type: string;
}

export interface CreateProducedWorkItemInput {
  group_folder: string;
  chat_jid: string;
  agent_type?: AgentType;
  delivery_role?: PairedRoomRole | null;
  start_seq: number | null;
  end_seq: number | null;
  result_payload: string;
}

function normalizeStoredAgentType(
  agentType: string | null | undefined,
): AgentType | undefined {
  if (agentType === 'claude-code' || agentType === 'codex') return agentType;
  return undefined;
}

function hydrateWorkItemRow(row: StoredWorkItemRow): WorkItem {
  const agentType = normalizeStoredAgentType(row.agent_type) ?? 'claude-code';
  return {
    ...row,
    agent_type: agentType,
    service_id: resolveWorkItemServiceShadow(agentType, row.delivery_role),
  };
}

export function getOpenWorkItemFromDatabase(
  database: Database,
  chatJid: string,
  agentType: AgentType = 'claude-code',
  serviceId: string = SERVICE_SESSION_SCOPE,
): WorkItem | undefined {
  const preferredRole = inferRoleFromServiceShadow(agentType, serviceId);
  const row = database
    .prepare(
      `SELECT *
       FROM work_items
       WHERE chat_jid = ? AND agent_type = ?
         AND status IN ('produced', 'delivery_retry')
       ORDER BY
         CASE
           WHEN ? IS NOT NULL AND delivery_role = ? THEN 0
           WHEN delivery_role IS NULL THEN 1
           ELSE 2
         END,
         id ASC
       LIMIT 1`,
    )
    .get(chatJid, agentType, preferredRole, preferredRole) as
    | StoredWorkItemRow
    | undefined;
  return row ? hydrateWorkItemRow(row) : undefined;
}

export function getOpenWorkItemForChatFromDatabase(
  database: Database,
  chatJid: string,
): WorkItem | undefined {
  const row = database
    .prepare(
      `SELECT *
       FROM work_items
       WHERE chat_jid = ?
         AND status IN ('produced', 'delivery_retry')
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get(chatJid) as StoredWorkItemRow | undefined;
  return row ? hydrateWorkItemRow(row) : undefined;
}

export function createProducedWorkItemInDatabase(
  database: Database,
  input: CreateProducedWorkItemInput,
): WorkItem {
  const now = new Date().toISOString();
  const agentType = input.agent_type || 'claude-code';
  database
    .prepare(
      `INSERT INTO work_items (
         group_folder,
         chat_jid,
         agent_type,
         delivery_role,
         status,
         start_seq,
         end_seq,
         result_payload,
         delivery_attempts,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, 'produced', ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      input.group_folder,
      input.chat_jid,
      agentType,
      input.delivery_role ?? null,
      input.start_seq,
      input.end_seq,
      input.result_payload,
      now,
      now,
    );

  const lastId = (
    database.prepare('SELECT last_insert_rowid() as id').get() as { id: number }
  ).id;
  return hydrateWorkItemRow(
    database.prepare('SELECT * FROM work_items WHERE id = ?').get(lastId) as
      | StoredWorkItemRow,
  );
}

export function markWorkItemDeliveredInDatabase(
  database: Database,
  id: number,
  deliveryMessageId?: string | null,
): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `UPDATE work_items
     SET status = 'delivered',
         delivered_at = ?,
         delivery_message_id = ?,
         updated_at = ?
     WHERE id = ?`,
    )
    .run(now, deliveryMessageId || null, now, id);
}

export function markWorkItemDeliveryRetryInDatabase(
  database: Database,
  id: number,
  error: string,
): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `UPDATE work_items
     SET status = 'delivery_retry',
         delivery_attempts = delivery_attempts + 1,
         last_error = ?,
         updated_at = ?
     WHERE id = ?`,
    )
    .run(error, now, id);
}
