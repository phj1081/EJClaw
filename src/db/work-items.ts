import { Database } from 'bun:sqlite';

import { SERVICE_SESSION_SCOPE, normalizeServiceId } from '../config.js';
import {
  inferAgentTypeFromServiceShadow,
  inferRoleFromServiceShadow,
  resolveRoleServiceShadow,
} from '../role-service-shadow.js';
import { AgentType, PairedRoomRole } from '../types.js';

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
  'agent_type' | 'service_id'
> {
  agent_type: string;
  service_id?: string | null;
}

export interface CreateProducedWorkItemInput {
  group_folder: string;
  chat_jid: string;
  agent_type?: AgentType;
  service_id?: string;
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

function resolveStoredWorkItemServiceId(args: {
  agentType: AgentType;
  deliveryRole?: PairedRoomRole | null;
  serviceId?: string | null;
}): string {
  return (
    (args.serviceId ? normalizeServiceId(args.serviceId) : null) ??
    resolveRoleServiceShadow(args.deliveryRole ?? 'owner', args.agentType) ??
    SERVICE_SESSION_SCOPE
  );
}

function hydrateWorkItemRow(row: StoredWorkItemRow): WorkItem {
  const agentType = normalizeStoredAgentType(row.agent_type) ?? 'claude-code';
  return {
    ...row,
    agent_type: agentType,
    service_id: resolveStoredWorkItemServiceId({
      agentType,
      deliveryRole: row.delivery_role,
      serviceId: row.service_id,
    }),
  };
}

function resolvePreferredWorkItemRole(
  serviceId: string | null | undefined,
): PairedRoomRole | null {
  const normalizedServiceId = serviceId ? normalizeServiceId(serviceId) : null;
  if (!normalizedServiceId) {
    return null;
  }

  const inferredAgentType =
    inferAgentTypeFromServiceShadow(normalizedServiceId);
  return inferRoleFromServiceShadow(inferredAgentType, normalizedServiceId);
}

export function getOpenWorkItemFromDatabase(
  database: Database,
  chatJid: string,
  agentType: AgentType = 'claude-code',
  serviceId: string = SERVICE_SESSION_SCOPE,
): WorkItem | undefined {
  const normalizedServiceId = normalizeServiceId(serviceId);
  const preferredRole = inferRoleFromServiceShadow(
    agentType,
    normalizedServiceId,
  );
  const row = database
    .prepare(
      `SELECT *
       FROM work_items
       WHERE chat_jid = ? AND agent_type = ?
         AND status IN ('produced', 'delivery_retry')
         AND (
           service_id = ?
           OR (? IS NOT NULL AND delivery_role = ?)
           OR (? IS NULL AND delivery_role IS NULL)
         )
       ORDER BY
         CASE
           WHEN service_id = ? THEN 0
           WHEN ? IS NOT NULL AND delivery_role = ? THEN 1
           ELSE 2
         END,
         id ASC
       LIMIT 1`,
    )
    .get(
      chatJid,
      agentType,
      normalizedServiceId,
      preferredRole,
      preferredRole,
      preferredRole,
      normalizedServiceId,
      preferredRole,
      preferredRole,
    ) as StoredWorkItemRow | undefined;
  return row ? hydrateWorkItemRow(row) : undefined;
}

export function getOpenWorkItemForChatFromDatabase(
  database: Database,
  chatJid: string,
  serviceId: string = SERVICE_SESSION_SCOPE,
): WorkItem | undefined {
  const normalizedServiceId = normalizeServiceId(serviceId);
  const preferredRole = resolvePreferredWorkItemRole(normalizedServiceId);
  const row = database
    .prepare(
      `SELECT *
       FROM work_items
       WHERE chat_jid = ?
         AND status IN ('produced', 'delivery_retry')
         AND (
           service_id = ?
           OR (? IS NOT NULL AND delivery_role = ?)
           OR (? IS NULL AND delivery_role IS NULL)
         )
       ORDER BY
         CASE
           WHEN service_id = ? THEN 0
           WHEN ? IS NOT NULL AND delivery_role = ? THEN 1
           ELSE 2
         END,
         id ASC
       LIMIT 1`,
    )
    .get(
      chatJid,
      normalizedServiceId,
      preferredRole,
      preferredRole,
      preferredRole,
      normalizedServiceId,
      preferredRole,
      preferredRole,
    ) as StoredWorkItemRow | undefined;
  return row ? hydrateWorkItemRow(row) : undefined;
}

export function createProducedWorkItemInDatabase(
  database: Database,
  input: CreateProducedWorkItemInput,
): WorkItem {
  const now = new Date().toISOString();
  const agentType = input.agent_type || 'claude-code';
  const serviceId = resolveStoredWorkItemServiceId({
    agentType,
    deliveryRole: input.delivery_role,
    serviceId: input.service_id,
  });
  database
    .prepare(
      `INSERT INTO work_items (
         group_folder,
         chat_jid,
         agent_type,
         service_id,
         delivery_role,
         status,
         start_seq,
         end_seq,
       result_payload,
       delivery_attempts,
       created_at,
       updated_at
       ) VALUES (?, ?, ?, ?, ?, 'produced', ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      input.group_folder,
      input.chat_jid,
      agentType,
      serviceId,
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
    database
      .prepare('SELECT * FROM work_items WHERE id = ?')
      .get(lastId) as StoredWorkItemRow,
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
