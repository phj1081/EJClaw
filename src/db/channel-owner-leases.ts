import { Database } from 'bun:sqlite';

import { AgentType } from '../types.js';
import {
  fillCanonicalChannelOwnerLeaseMetadata,
  readCanonicalChannelOwnerLeaseMetadata,
} from './canonical-role-metadata.js';

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
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  arbiter_service_id?: string | null;
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
  const {
    ownerAgentType,
    reviewerAgentType,
    arbiterAgentType,
    ownerServiceId,
    reviewerServiceId,
    arbiterServiceId,
  } = readCanonicalChannelOwnerLeaseMetadata({
    chat_jid: row.chat_jid,
    owner_service_id: row.owner_service_id,
    reviewer_service_id: row.reviewer_service_id,
    arbiter_service_id: row.arbiter_service_id,
    owner_agent_type: row.owner_agent_type,
    reviewer_agent_type: row.reviewer_agent_type,
    arbiter_agent_type: row.arbiter_agent_type,
  });

  return {
    chat_jid: row.chat_jid,
    owner_service_id: ownerServiceId,
    reviewer_service_id: reviewerServiceId,
    arbiter_service_id: arbiterServiceId,
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
    .prepare(`SELECT * FROM channel_owner WHERE chat_jid = ?`)
    .get(chatJid) as StoredChannelOwnerLeaseRow | undefined;
  return row ? hydrateChannelOwnerLeaseRow(row) : undefined;
}

export function getAllChannelOwnerLeasesFromDatabase(
  database: Database,
): ChannelOwnerLeaseRow[] {
  const rows = database
    .prepare(`SELECT * FROM channel_owner`)
    .all() as StoredChannelOwnerLeaseRow[];
  return rows.map(hydrateChannelOwnerLeaseRow);
}

export function setChannelOwnerLeaseInDatabase(
  database: Database,
  input: SetChannelOwnerLeaseInput,
): void {
  const {
    ownerAgentType,
    reviewerAgentType,
    arbiterAgentType,
    ownerServiceId,
    reviewerServiceId,
    arbiterServiceId,
  } = fillCanonicalChannelOwnerLeaseMetadata({
    chat_jid: input.chat_jid,
    owner_service_id: input.owner_service_id,
    reviewer_service_id: input.reviewer_service_id,
    arbiter_service_id: input.arbiter_service_id,
    owner_agent_type: input.owner_agent_type,
    reviewer_agent_type: input.reviewer_agent_type,
    arbiter_agent_type: input.arbiter_agent_type,
  });

  database
    .prepare(
      `INSERT OR REPLACE INTO channel_owner (
        chat_jid,
        owner_service_id,
        reviewer_service_id,
        arbiter_service_id,
        owner_agent_type,
        reviewer_agent_type,
        arbiter_agent_type,
        activated_at,
        reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.chat_jid,
      ownerServiceId,
      reviewerServiceId,
      arbiterServiceId,
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
