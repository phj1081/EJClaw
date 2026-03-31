import {
  ARBITER_SERVICE_ID,
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  OWNER_AGENT_TYPE,
  REVIEWER_SERVICE_ID_FOR_TYPE,
  SERVICE_ID,
  isArbiterEnabled,
  normalizeServiceId,
} from './config.js';
import {
  clearChannelOwnerLease,
  getAllChannelOwnerLeases,
  getEffectiveRuntimeRoomMode,
  getRegisteredAgentTypesForJid,
  setChannelOwnerLease,
  type ChannelOwnerLeaseRow,
} from './db.js';
import { logger } from './logger.js';

export interface EffectiveChannelLease {
  chat_jid: string;
  owner_service_id: string;
  reviewer_service_id: string | null;
  arbiter_service_id: string | null;
  activated_at: string | null;
  reason: string | null;
  explicit: boolean;
}

const LEASE_CACHE_REFRESH_MS = 2_000;

let lastLeaseRefreshAt = 0;
const leaseCache = new Map<string, ChannelOwnerLeaseRow>();

function normalizeLeaseRow(
  row: ChannelOwnerLeaseRow,
  explicit: boolean,
): EffectiveChannelLease {
  return {
    chat_jid: row.chat_jid,
    owner_service_id: normalizeServiceId(row.owner_service_id),
    reviewer_service_id: row.reviewer_service_id
      ? normalizeServiceId(row.reviewer_service_id)
      : null,
    arbiter_service_id: row.arbiter_service_id
      ? normalizeServiceId(row.arbiter_service_id)
      : isArbiterEnabled()
        ? ARBITER_SERVICE_ID
        : null,
    activated_at: row.activated_at,
    reason: row.reason,
    explicit,
  };
}

function getDefaultLease(chatJid: string): EffectiveChannelLease {
  const types = getRegisteredAgentTypesForJid(chatJid);
  const hasClaude = types.includes('claude-code');
  const hasCodex = types.includes('codex');
  const roomMode = getEffectiveRuntimeRoomMode(chatJid);

  if (roomMode === 'tribunal') {
    const ownerServiceId =
      hasClaude && hasCodex
        ? OWNER_AGENT_TYPE === 'codex'
          ? CODEX_MAIN_SERVICE_ID
          : CLAUDE_SERVICE_ID
        : hasCodex
          ? CODEX_MAIN_SERVICE_ID
          : CLAUDE_SERVICE_ID;
    return {
      chat_jid: chatJid,
      owner_service_id: ownerServiceId,
      reviewer_service_id: REVIEWER_SERVICE_ID_FOR_TYPE,
      arbiter_service_id: isArbiterEnabled() ? ARBITER_SERVICE_ID : null,
      activated_at: null,
      reason: null,
      explicit: false,
    };
  }

  if (hasCodex) {
    return {
      chat_jid: chatJid,
      owner_service_id: CODEX_MAIN_SERVICE_ID,
      reviewer_service_id: null,
      arbiter_service_id: null,
      activated_at: null,
      reason: null,
      explicit: false,
    };
  }

  if (hasClaude) {
    return {
      chat_jid: chatJid,
      owner_service_id: CLAUDE_SERVICE_ID,
      reviewer_service_id: null,
      arbiter_service_id: null,
      activated_at: null,
      reason: null,
      explicit: false,
    };
  }

  return {
    chat_jid: chatJid,
    owner_service_id: CLAUDE_SERVICE_ID,
    reviewer_service_id: null,
    arbiter_service_id: null,
    activated_at: null,
    reason: null,
    explicit: false,
  };
}

export function refreshChannelOwnerCache(force = false): void {
  const now = Date.now();
  if (!force && now - lastLeaseRefreshAt < LEASE_CACHE_REFRESH_MS) {
    return;
  }

  leaseCache.clear();
  for (const row of getAllChannelOwnerLeases()) {
    leaseCache.set(row.chat_jid, row);
  }
  lastLeaseRefreshAt = now;
}

export function getEffectiveChannelLease(
  chatJid: string,
): EffectiveChannelLease {
  // Global failover overrides all per-channel leases
  if (globalFailoverActive) {
    return {
      chat_jid: chatJid,
      owner_service_id: CODEX_REVIEW_SERVICE_ID,
      reviewer_service_id: CODEX_MAIN_SERVICE_ID,
      arbiter_service_id: null,
      activated_at: globalFailoverActivatedAt,
      reason: globalFailoverReason,
      explicit: true,
    };
  }
  refreshChannelOwnerCache();
  const row = leaseCache.get(chatJid);
  if (row) {
    return normalizeLeaseRow(row, true);
  }
  return getDefaultLease(chatJid);
}

export function isOwnerServiceForChat(
  chatJid: string,
  serviceId: string = SERVICE_ID,
): boolean {
  const lease = getEffectiveChannelLease(chatJid);
  return normalizeServiceId(serviceId) === lease.owner_service_id;
}

export function isReviewerServiceForChat(
  chatJid: string,
  serviceId: string = SERVICE_ID,
): boolean {
  const lease = getEffectiveChannelLease(chatJid);
  return (
    lease.reviewer_service_id !== null &&
    normalizeServiceId(serviceId) === lease.reviewer_service_id
  );
}

export function isArbiterServiceForChat(
  chatJid: string,
  serviceId: string = SERVICE_ID,
): boolean {
  const lease = getEffectiveChannelLease(chatJid);
  return (
    lease.arbiter_service_id !== null &&
    normalizeServiceId(serviceId) === lease.arbiter_service_id
  );
}

export function shouldServiceProcessChat(
  _chatJid: string,
  _serviceId: string = SERVICE_ID,
): boolean {
  return true;
}

// ── Global failover ──────────────────────────────────────────────
// Claude API limits are account-level, so failover applies to all channels.

let globalFailoverActive = false;
let globalFailoverReason: string | null = null;
let globalFailoverActivatedAt: string | null = null;

export function activateCodexFailover(_chatJid: string, reason: string): void {
  globalFailoverActive = true;
  globalFailoverReason = reason;
  globalFailoverActivatedAt = new Date().toISOString();
  logger.warn(
    { reason, activatedAt: globalFailoverActivatedAt },
    'Global failover activated — all channels switching to codex',
  );
}

export function isGlobalFailoverActive(): boolean {
  return globalFailoverActive;
}

export function getGlobalFailoverInfo(): {
  active: boolean;
  reason: string | null;
  activatedAt: string | null;
} {
  return {
    active: globalFailoverActive,
    reason: globalFailoverReason,
    activatedAt: globalFailoverActivatedAt,
  };
}

export function clearGlobalFailover(): void {
  if (!globalFailoverActive) return;
  globalFailoverActive = false;
  globalFailoverReason = null;
  globalFailoverActivatedAt = null;
  logger.info('Global failover cleared — resuming normal routing');
}

export function restoreDefaultChannelLease(chatJid: string): void {
  clearChannelOwnerLease(chatJid);
  leaseCache.delete(chatJid);
  lastLeaseRefreshAt = Date.now();
}

export interface ActiveFailoverLease {
  chatJid: string;
  activatedAt: string | null;
}

export function getActiveCodexFailoverLeases(): ActiveFailoverLease[] {
  // Global failover: report as a single pseudo-lease
  if (globalFailoverActive) {
    return [{ chatJid: '*', activatedAt: globalFailoverActivatedAt }];
  }
  return [];
}

/** @deprecated Use getActiveCodexFailoverLeases() instead */
export function getActiveCodexFailoverChatJids(): string[] {
  return getActiveCodexFailoverLeases().map((l) => l.chatJid);
}
