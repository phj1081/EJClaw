import {
  ARBITER_SERVICE_ID,
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  normalizeServiceId,
} from './config.js';
import type { AgentType, PairedRoomRole } from './types.js';

export function resolveRoleServiceShadow(
  role: PairedRoomRole,
  agentType: AgentType | null | undefined,
): string | null {
  if (!agentType) {
    return null;
  }
  if (agentType === 'claude-code') {
    return CLAUDE_SERVICE_ID;
  }
  if (role === 'owner') {
    return CODEX_MAIN_SERVICE_ID;
  }
  if (role === 'arbiter') {
    return ARBITER_SERVICE_ID ?? CODEX_REVIEW_SERVICE_ID;
  }
  return CODEX_REVIEW_SERVICE_ID;
}

export function inferAgentTypeFromServiceShadow(
  serviceId: string | null | undefined,
): AgentType | undefined {
  if (!serviceId) {
    return undefined;
  }

  const normalized = normalizeServiceId(serviceId);
  if (normalized === CLAUDE_SERVICE_ID) {
    return 'claude-code';
  }
  if (
    normalized === CODEX_MAIN_SERVICE_ID ||
    normalized === CODEX_REVIEW_SERVICE_ID ||
    (ARBITER_SERVICE_ID != null && normalized === ARBITER_SERVICE_ID)
  ) {
    return 'codex';
  }
  return undefined;
}

export function inferRoleFromServiceShadow(
  agentType: AgentType | null | undefined,
  serviceId: string | null | undefined,
): PairedRoomRole | null {
  if (!agentType || !serviceId) {
    return null;
  }

  const normalized = normalizeServiceId(serviceId);
  const matches = (['owner', 'reviewer', 'arbiter'] as const).filter(
    (role) => resolveRoleServiceShadow(role, agentType) === normalized,
  );

  if (matches.length !== 1) {
    return null;
  }

  return matches[0];
}
