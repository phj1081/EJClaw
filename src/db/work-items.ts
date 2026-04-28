import { Database } from 'bun:sqlite';

import { SERVICE_SESSION_SCOPE, normalizeServiceId } from '../config.js';
import {
  inferAgentTypeFromServiceShadow,
  inferRoleFromServiceShadow,
  resolveRoleServiceShadow,
} from '../role-service-shadow.js';
import { AgentType, OutboundAttachment, PairedRoomRole } from '../types.js';

const SUPERSEDED_WORK_ITEM_ERROR = 'superseded_by_newer_canonical_output';

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
  attachments?: OutboundAttachment[];
  delivery_attempts: number;
  delivery_message_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

interface StoredWorkItemRow extends Omit<
  WorkItem,
  'agent_type' | 'service_id' | 'attachments'
> {
  agent_type: string;
  service_id?: string | null;
  attachment_payload?: string | null;
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
  attachments?: OutboundAttachment[];
}

function normalizeStoredAgentType(
  agentType: string | null | undefined,
): AgentType | undefined {
  if (agentType === 'claude-code' || agentType === 'codex') return agentType;
  return undefined;
}

function fillCanonicalWorkItemServiceId(args: {
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

function readStoredWorkItemAgentType(
  row: Pick<StoredWorkItemRow, 'id' | 'agent_type'>,
): AgentType {
  const agentType = normalizeStoredAgentType(row.agent_type);
  if (agentType) {
    return agentType;
  }

  throw new Error(
    `work_items(${row.id}): cannot read agent_type from stored row metadata`,
  );
}

function readStoredWorkItemServiceId(
  row: Pick<StoredWorkItemRow, 'id' | 'service_id'>,
): string {
  if (row.service_id) {
    return normalizeServiceId(row.service_id);
  }

  throw new Error(
    `work_items(${row.id}): cannot read service_id from stored row metadata`,
  );
}

function hydrateWorkItemRow(row: StoredWorkItemRow): WorkItem {
  const agentType = readStoredWorkItemAgentType(row);
  return {
    ...row,
    agent_type: agentType,
    service_id: readStoredWorkItemServiceId(row),
    attachments: parseAttachmentPayload(row.attachment_payload),
  };
}

function parseAttachmentPayload(
  payload: string | null | undefined,
): OutboundAttachment[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is OutboundAttachment =>
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          typeof (item as { path?: unknown }).path === 'string',
      )
      .map((item) => ({
        path: item.path,
        ...(typeof item.name === 'string' ? { name: item.name } : {}),
        ...(typeof item.mime === 'string' ? { mime: item.mime } : {}),
      }));
  } catch {
    return [];
  }
}

function serializeAttachmentPayload(
  attachments: OutboundAttachment[] | undefined,
): string | null {
  if (!attachments?.length) return null;
  return JSON.stringify(
    attachments.map((attachment) => ({
      path: attachment.path,
      ...(attachment.name ? { name: attachment.name } : {}),
      ...(attachment.mime ? { mime: attachment.mime } : {}),
    })),
  );
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

export function getRecentDeliveredWorkItemsForChatFromDatabase(
  database: Database,
  chatJid: string,
  limit: number = 8,
): WorkItem[] {
  const rows = database
    .prepare(
      `SELECT *
       FROM work_items
       WHERE chat_jid = ?
         AND status = 'delivered'
         AND (last_error IS NULL OR last_error <> ?)
       ORDER BY COALESCE(delivered_at, updated_at, created_at) DESC, id DESC
       LIMIT ?`,
    )
    .all(chatJid, SUPERSEDED_WORK_ITEM_ERROR, limit) as StoredWorkItemRow[];
  return rows.reverse().map(hydrateWorkItemRow);
}

function supersedeOpenWorkItemsForCanonicalKey(
  database: Database,
  input: CreateProducedWorkItemInput,
  agentType: AgentType,
  serviceId: string,
  now: string,
): void {
  database
    .prepare(
      `UPDATE work_items
       SET status = 'delivered',
           delivered_at = ?,
           delivery_message_id = NULL,
           last_error = ?,
           updated_at = ?
       WHERE chat_jid = ?
         AND agent_type = ?
         AND IFNULL(service_id, '') = IFNULL(?, '')
         AND IFNULL(delivery_role, '') = IFNULL(?, '')
         AND status IN ('produced', 'delivery_retry')`,
    )
    .run(
      now,
      SUPERSEDED_WORK_ITEM_ERROR,
      now,
      input.chat_jid,
      agentType,
      serviceId,
      input.delivery_role ?? null,
    );
}

export function createProducedWorkItemInDatabase(
  database: Database,
  input: CreateProducedWorkItemInput,
): WorkItem {
  const now = new Date().toISOString();
  const agentType = input.agent_type || 'claude-code';
  const serviceId = fillCanonicalWorkItemServiceId({
    agentType,
    deliveryRole: input.delivery_role,
    serviceId: input.service_id,
  });
  return database.transaction(() => {
    supersedeOpenWorkItemsForCanonicalKey(
      database,
      input,
      agentType,
      serviceId,
      now,
    );
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
           attachment_payload,
           delivery_attempts,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, 'produced', ?, ?, ?, ?, 0, ?, ?)`,
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
        serializeAttachmentPayload(input.attachments),
        now,
        now,
      );

    const lastId = (
      database.prepare('SELECT last_insert_rowid() as id').get() as {
        id: number;
      }
    ).id;
    return hydrateWorkItemRow(
      database
        .prepare('SELECT * FROM work_items WHERE id = ?')
        .get(lastId) as StoredWorkItemRow,
    );
  })();
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
