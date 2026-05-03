import path from 'node:path';

import {
  getAllRoomBindings,
  getRegisteredAgentTypesForJid,
  getStoredRoomSkillOverrides,
} from './db.js';
import {
  getRuntimeInventory,
  type RuntimeInventorySnapshot,
  type RuntimeSkillDirSnapshot,
  type RuntimeSkillSummary,
} from './runtime-inventory.js';
import type { AgentType, RegisteredGroup, RoomMode } from './types.js';
import type { StoredRoomSkillOverride } from './db/rooms.js';

export type RoomSkillScope = 'codex-user' | 'claude-user' | 'runner';

export interface RoomSkillCatalogItem {
  id: string;
  scope: RoomSkillScope;
  name: string;
  displayName: string;
  description: string | null;
  path: string;
  agentTypes: AgentType[];
}

export interface RoomSkillAgentPolicy {
  agentType: AgentType;
  mode: 'all-enabled' | 'custom';
  availableSkillIds: string[];
  disabledSkillIds: string[];
  explicitEnabledSkillIds: string[];
  effectiveEnabledSkillIds: string[];
}

export interface RoomSkillPolicyRoom {
  jid: string;
  name: string;
  folder: string;
  roomMode?: RoomMode;
  agents: RoomSkillAgentPolicy[];
}

export interface RoomSkillSettingsSnapshot {
  generatedAt: string;
  catalog: RoomSkillCatalogItem[];
  rooms: RoomSkillPolicyRoom[];
}

export interface RoomSkillSettingsBuildInput {
  generatedAt?: string;
  inventory: RuntimeInventorySnapshot;
  roomBindings: Record<string, RegisteredGroup>;
  registeredAgentTypesByJid?: Map<string, AgentType[]>;
  overrides?: StoredRoomSkillOverride[];
}

function skillId(scope: RoomSkillScope, name: string): string {
  return `${scope}:${name}`;
}

function skillNameFromPath(skill: RuntimeSkillSummary): string {
  return path.basename(skill.path);
}

function addSkillsFromDir(
  catalog: Map<string, RoomSkillCatalogItem>,
  dir: RuntimeSkillDirSnapshot,
  scope: RoomSkillScope,
  agentTypes: AgentType[],
): void {
  if (!dir.exists) return;
  for (const skill of dir.skills) {
    const name = skillNameFromPath(skill);
    if (!name) continue;
    const id = skillId(scope, name);
    const existing = catalog.get(id);
    if (existing) {
      const types = new Set<AgentType>([...existing.agentTypes, ...agentTypes]);
      existing.agentTypes = [...types].sort();
      continue;
    }
    catalog.set(id, {
      id,
      scope,
      name,
      displayName: skill.name,
      description: skill.description,
      path: skill.path,
      agentTypes: [...agentTypes].sort(),
    });
  }
}

export function buildRoomSkillCatalog(
  inventory: RuntimeInventorySnapshot,
): RoomSkillCatalogItem[] {
  const catalog = new Map<string, RoomSkillCatalogItem>();
  const runnerPath = inventory.ejclaw.runnerSkillDir.path;
  const codexUserDir = inventory.codex.skillDirs.find(
    (dir) => dir.path !== runnerPath,
  );
  const claudeUserDir = inventory.claude.skillDirs.find(
    (dir) => dir.path !== runnerPath,
  );

  if (codexUserDir) {
    addSkillsFromDir(catalog, codexUserDir, 'codex-user', ['codex']);
  }
  if (claudeUserDir) {
    addSkillsFromDir(catalog, claudeUserDir, 'claude-user', ['claude-code']);
  }
  addSkillsFromDir(catalog, inventory.ejclaw.runnerSkillDir, 'runner', [
    'claude-code',
    'codex',
  ]);

  return [...catalog.values()].sort((a, b) => {
    const scopeCompare = a.scope.localeCompare(b.scope);
    return scopeCompare === 0
      ? a.displayName.localeCompare(b.displayName)
      : scopeCompare;
  });
}

function overrideKey(
  jid: string,
  agentType: AgentType,
  scope: string,
  name: string,
): string {
  return `${jid}\u0000${agentType}\u0000${scope}\u0000${name}`;
}

function resolveRoomAgentTypes(
  jid: string,
  group: RegisteredGroup,
  registeredAgentTypesByJid?: Map<string, AgentType[]>,
): AgentType[] {
  const registered = registeredAgentTypesByJid?.get(jid) ?? [];
  const types = new Set<AgentType>(registered);
  if (group.agentType) types.add(group.agentType);
  if (types.size === 0) types.add('claude-code');
  return [...types].sort();
}

export function buildRoomSkillSettingsSnapshot({
  generatedAt,
  inventory,
  roomBindings,
  registeredAgentTypesByJid,
  overrides = [],
}: RoomSkillSettingsBuildInput): RoomSkillSettingsSnapshot {
  const catalog = buildRoomSkillCatalog(inventory);
  const overridesByKey = new Map(
    overrides.map((override) => [
      overrideKey(
        override.chatJid,
        override.agentType,
        override.skillScope,
        override.skillName,
      ),
      override,
    ]),
  );

  const rooms = Object.entries(roomBindings)
    .map(([jid, group]) => {
      const agentTypes = resolveRoomAgentTypes(
        jid,
        group,
        registeredAgentTypesByJid,
      );
      return {
        jid,
        name: group.name,
        folder: group.folder,
        agents: agentTypes.map((agentType) => {
          const available = catalog.filter((skill) =>
            skill.agentTypes.includes(agentType),
          );
          const disabledSkillIds: string[] = [];
          const explicitEnabledSkillIds: string[] = [];
          const effectiveEnabledSkillIds: string[] = [];

          for (const skill of available) {
            const override = overridesByKey.get(
              overrideKey(jid, agentType, skill.scope, skill.name),
            );
            if (override?.enabled === false) {
              disabledSkillIds.push(skill.id);
              continue;
            }
            if (override?.enabled === true) {
              explicitEnabledSkillIds.push(skill.id);
            }
            effectiveEnabledSkillIds.push(skill.id);
          }

          return {
            agentType,
            mode:
              disabledSkillIds.length > 0 || explicitEnabledSkillIds.length > 0
                ? 'custom'
                : 'all-enabled',
            availableSkillIds: available.map((skill) => skill.id),
            disabledSkillIds,
            explicitEnabledSkillIds,
            effectiveEnabledSkillIds,
          } satisfies RoomSkillAgentPolicy;
        }),
      } satisfies RoomSkillPolicyRoom;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: generatedAt ?? new Date().toISOString(),
    catalog,
    rooms,
  };
}

export function getRoomSkillSettings(): RoomSkillSettingsSnapshot {
  const roomBindings = getAllRoomBindings();
  const registeredAgentTypesByJid = new Map(
    Object.keys(roomBindings).map((jid) => [
      jid,
      getRegisteredAgentTypesForJid(jid),
    ]),
  );
  return buildRoomSkillSettingsSnapshot({
    inventory: getRuntimeInventory(),
    roomBindings,
    registeredAgentTypesByJid,
    overrides: getStoredRoomSkillOverrides(),
  });
}
