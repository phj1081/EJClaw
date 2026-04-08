import { Database } from 'bun:sqlite';

import {
  ARBITER_AGENT_TYPE,
  CLAUDE_SERVICE_ID,
  OWNER_AGENT_TYPE,
} from '../config.js';
import {
  inferAgentTypeFromServiceShadow,
  resolveRoleServiceShadow,
} from '../role-service-shadow.js';
import { AgentType } from '../types.js';
import { resolveStableReviewerAgentType } from './legacy-rebuilds.js';
import { normalizeStoredAgentType } from './room-registration.js';

export interface ChannelOwnerLeaseRow {
  chat_jid: string;
  owner_service_id: string;
  reviewer_service_id: string | null;
  arbiter_service_id: string | null;
  owner_agent_type?: AgentType | null;
  reviewer_agent_type?: AgentType | null;
  arbiter_agent_type?: AgentType | null;
  activated_at: string | null;
  reason: string | null;
}

interface StoredChannelOwnerLeaseRow {
  chat_jid: string;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
  activated_at: string | null;
  reason: string | null;
}

export interface SetChannelOwnerLeaseInput {
  chat_jid: string;
  owner_service_id?: string;
  reviewer_service_id?: string | null;
  arbiter_service_id?: string | null;
  owner_agent_type?: AgentType | null;
  reviewer_agent_type?: AgentType | null;
  arbiter_agent_type?: AgentType | null;
  activated_at?: string | null;
  reason?: string | null;
}

function hydrateChannelOwnerLeaseRow(
  row: StoredChannelOwnerLeaseRow,
): ChannelOwnerLeaseRow {
  const ownerAgentType =
    normalizeStoredAgentType(row.owner_agent_type) ?? OWNER_AGENT_TYPE;
  const reviewerAgentType =
    row.reviewer_agent_type == null
      ? null
      : (normalizeStoredAgentType(row.reviewer_agent_type) ??
        resolveStableReviewerAgentType(ownerAgentType, null));
  const arbiterAgentType =
    row.arbiter_agent_type == null
      ? null
      : (normalizeStoredAgentType(row.arbiter_agent_type) ??
        ARBITER_AGENT_TYPE ??
        null);

  return {
    chat_jid: row.chat_jid,
    owner_service_id:
      resolveRoleServiceShadow('owner', ownerAgentType) ?? CLAUDE_SERVICE_ID,
    reviewer_service_id:
      reviewerAgentType == null
        ? null
        : resolveRoleServiceShadow('reviewer', reviewerAgentType),
    arbiter_service_id:
      arbiterAgentType == null
        ? null
        : resolveRoleServiceShadow('arbiter', arbiterAgentType),
    owner_agent_type: ownerAgentType,
    reviewer_agent_type: reviewerAgentType,
    arbiter_agent_type: arbiterAgentType,
    activated_at: row.activated_at,
    reason: row.reason,
  };
}

export function getChannelOwnerLeaseFromDatabase(
  database: Database,
  chatJid: string,
): ChannelOwnerLeaseRow | undefined {
  const row = database
    .prepare(
      `SELECT
         chat_jid,
         owner_agent_type,
         reviewer_agent_type,
         arbiter_agent_type,
         activated_at,
         reason
       FROM channel_owner
       WHERE chat_jid = ?`,
    )
    .get(chatJid) as StoredChannelOwnerLeaseRow | undefined;
  return row ? hydrateChannelOwnerLeaseRow(row) : undefined;
}

export function getAllChannelOwnerLeasesFromDatabase(
  database: Database,
): ChannelOwnerLeaseRow[] {
  const rows = database
    .prepare(
      `SELECT
         chat_jid,
         owner_agent_type,
         reviewer_agent_type,
         arbiter_agent_type,
         activated_at,
         reason
       FROM channel_owner`,
    )
    .all() as StoredChannelOwnerLeaseRow[];
  return rows.map(hydrateChannelOwnerLeaseRow);
}

export function setChannelOwnerLeaseInDatabase(
  database: Database,
  input: SetChannelOwnerLeaseInput,
): void {
  const ownerAgentType =
    normalizeStoredAgentType(input.owner_agent_type) ??
    inferAgentTypeFromServiceShadow(input.owner_service_id) ??
    OWNER_AGENT_TYPE;
  const reviewerAgentType =
    input.reviewer_service_id == null && input.reviewer_agent_type == null
      ? null
      : (normalizeStoredAgentType(input.reviewer_agent_type) ??
        inferAgentTypeFromServiceShadow(input.reviewer_service_id ?? null) ??
        resolveStableReviewerAgentType(ownerAgentType, null));
  const arbiterAgentType =
    input.arbiter_service_id == null && input.arbiter_agent_type == null
      ? null
      : (normalizeStoredAgentType(input.arbiter_agent_type) ??
        inferAgentTypeFromServiceShadow(input.arbiter_service_id ?? null) ??
        ARBITER_AGENT_TYPE ??
        null);

  database
    .prepare(
      `INSERT OR REPLACE INTO channel_owner (
        chat_jid,
        owner_agent_type,
        reviewer_agent_type,
        arbiter_agent_type,
        activated_at,
        reason
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.chat_jid,
      ownerAgentType ?? null,
      reviewerAgentType ?? null,
      arbiterAgentType ?? null,
      input.activated_at ?? new Date().toISOString(),
      input.reason ?? null,
    );
}

export function clearChannelOwnerLeaseInDatabase(
  database: Database,
  chatJid: string,
): void {
  database.prepare('DELETE FROM channel_owner WHERE chat_jid = ?').run(chatJid);
}
