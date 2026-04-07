import type { PairedRoomRole } from './types.js';
import type { ServiceHandoff } from './db.js';

export function resolveHandoffRoleOverride(
  handoff: Pick<ServiceHandoff, 'target_role' | 'intended_role' | 'reason'>,
): PairedRoomRole | undefined {
  if (handoff.target_role) {
    return handoff.target_role;
  }
  if (handoff.intended_role) {
    return handoff.intended_role;
  }
  if (handoff.reason?.startsWith('reviewer-')) {
    return 'reviewer';
  }
  if (handoff.reason?.startsWith('arbiter-')) {
    return 'arbiter';
  }
  return undefined;
}

export function resolveHandoffCursorKey(
  chatJid: string,
  role?: PairedRoomRole,
): string {
  if (!role || role === 'owner') {
    return chatJid;
  }
  return `${chatJid}:${role}`;
}

export function getFixedRoleChannelName(role: 'reviewer' | 'arbiter'): string {
  return role === 'reviewer' ? 'discord-review' : 'discord-arbiter';
}

export function getMissingRoleChannelMessage(
  role: 'reviewer' | 'arbiter',
): string {
  return `Missing configured ${role} Discord bot channel (${getFixedRoleChannelName(role)}) for role-fixed delivery`;
}
