import {
  getAllRoomBindings,
  getRoomRoleAgentConfig,
  getStoredRoomRoleAgentPlan,
  getStoredRoomSettings,
  updateRoomRoleAgentConfig,
} from './db.js';
import { applyRoleModelSelectionToAgentConfig } from './db/room-registration.js';
import { getModelConfig } from './settings-store.js';
import { isEffortSupported } from './settings-effort.js';
import {
  isClaudeCompatibleAgentType,
  type AgentType,
  type RoomMode,
} from './types.js';

export type RoomModelRole = 'owner' | 'reviewer' | 'arbiter';

export interface RoomModelRoleSetting {
  role: RoomModelRole;
  agentType: AgentType;
  /** Room-level override; empty string when the room falls back to global. */
  model: string;
  effort: string;
  /** Effective global fallback (OWNER_/REVIEWER_/ARBITER_ env values). */
  globalModel: string;
  globalEffort: string;
}

export interface RoomModelSettingsRoom {
  jid: string;
  name: string;
  folder: string;
  roomMode: RoomMode;
  roles: RoomModelRoleSetting[];
}

export interface RoomModelSettingsSnapshot {
  generatedAt: string;
  rooms: RoomModelSettingsRoom[];
}

export interface RoomModelSettingUpdateInput {
  roomJid: string;
  role: string;
  model?: string;
  effort?: string;
}

export class RoomModelSettingsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RoomModelSettingsError';
  }
}

function roomModelValuesForRole(
  chatJid: string,
  role: RoomModelRole,
  agentType: AgentType,
): { model: string; effort: string } {
  const config = getRoomRoleAgentConfig(chatJid, role);
  const claudeFamily = isClaudeCompatibleAgentType(agentType);
  return {
    model: (claudeFamily ? config?.claudeModel : config?.codexModel) ?? '',
    effort: (claudeFamily ? config?.claudeEffort : config?.codexEffort) ?? '',
  };
}

export function getRoomModelSettings(): RoomModelSettingsSnapshot {
  const roomBindings = getAllRoomBindings();
  const globalConfig = getModelConfig();
  const rooms: RoomModelSettingsRoom[] = [];

  for (const [jid, group] of Object.entries(roomBindings)) {
    const stored = getStoredRoomSettings(jid);
    const plan = getStoredRoomRoleAgentPlan(jid);
    if (!stored || !plan) continue;

    const roleEntries: Array<{ role: RoomModelRole; agentType: AgentType }> = [
      { role: 'owner', agentType: plan.ownerAgentType },
    ];
    if (stored.roomMode === 'tribunal' && plan.reviewerAgentType) {
      roleEntries.push({ role: 'reviewer', agentType: plan.reviewerAgentType });
    }
    if (stored.roomMode === 'tribunal' && plan.arbiterAgentType) {
      roleEntries.push({ role: 'arbiter', agentType: plan.arbiterAgentType });
    }

    rooms.push({
      jid,
      name: group.name,
      folder: group.folder,
      roomMode: stored.roomMode,
      roles: roleEntries.map(({ role, agentType }) => ({
        role,
        agentType,
        ...roomModelValuesForRole(jid, role, agentType),
        globalModel: globalConfig[role].model,
        globalEffort: globalConfig[role].effort,
      })),
    });
  }

  rooms.sort((a, b) => a.name.localeCompare(b.name));
  return { generatedAt: new Date().toISOString(), rooms };
}

function normalizeRoomModelRole(role: string): RoomModelRole {
  if (role === 'owner' || role === 'reviewer' || role === 'arbiter') {
    return role;
  }
  throw new RoomModelSettingsError(`Unsupported role: ${role}`, 400);
}

export function updateRoomModelSetting(
  input: RoomModelSettingUpdateInput,
): RoomModelSettingsSnapshot {
  const roomJid = input.roomJid.trim();
  const role = normalizeRoomModelRole(input.role);
  if (input.model === undefined && input.effort === undefined) {
    throw new RoomModelSettingsError('model or effort is required', 400);
  }

  const snapshot = getRoomModelSettings();
  const room = snapshot.rooms.find((candidate) => candidate.jid === roomJid);
  if (!room) {
    throw new RoomModelSettingsError('Room not found', 404);
  }
  const roleSetting = room.roles.find((candidate) => candidate.role === role);
  if (!roleSetting) {
    throw new RoomModelSettingsError(
      `Role "${role}" is not configured for this room`,
      400,
    );
  }

  const effort = input.effort?.trim();
  if (effort && !isEffortSupported(roleSetting.agentType, effort)) {
    throw new RoomModelSettingsError(
      `effort "${effort}" is not supported for ${roleSetting.agentType} agents`,
      400,
    );
  }

  const nextConfig = applyRoleModelSelectionToAgentConfig(
    roleSetting.agentType,
    getRoomRoleAgentConfig(roomJid, role),
    {
      ...(input.model !== undefined
        ? { model: input.model.trim() || null }
        : {}),
      ...(input.effort !== undefined ? { effort: effort || null } : {}),
    },
  );
  const updated = updateRoomRoleAgentConfig(roomJid, role, nextConfig);
  if (!updated) {
    throw new RoomModelSettingsError(
      `Role "${role}" is not configured for this room`,
      400,
    );
  }

  return getRoomModelSettings();
}
