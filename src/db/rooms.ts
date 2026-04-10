import { Database } from 'bun:sqlite';

import { OWNER_AGENT_TYPE } from '../config.js';
import { isValidGroupFolder } from '../group-folder.js';
import type { AgentType, RegisteredGroup, RoomMode } from '../types.js';
import {
  type RoomModeSource,
  type RoomRegistrationSnapshot,
  type StoredRoomSettings,
  buildRegisteredGroupFromStoredSettings,
  getStoredRoomRowsFromDatabase,
  getStoredRoomSettingsRowFromDatabase,
  inferOwnerAgentTypeFromRegisteredAgentTypes,
  inferRoomModeFromRegisteredAgentTypes,
  inferStoredRoomCapabilityTypes,
  insertStoredRoomSettings,
  normalizeStoredAgentType,
  resolveAssignedRoomFolder,
  resolveStoredRoomCapabilityTypes,
  syncRoomRoleOverridesForRoom,
  updateStoredRoomMetadata,
  upsertRoomRoleOverride,
} from './room-registration.js';

interface StoredRoomModeRow {
  roomMode: RoomMode;
  source: RoomModeSource;
}

export interface AssignRoomInput {
  name: string;
  roomMode?: RoomMode;
  ownerAgentType?: AgentType;
  folder?: string;
  isMain?: boolean;
  workDir?: string;
  addedAt?: string;
  ownerAgentConfig?: RegisteredGroup['agentConfig'];
}

export function setStoredRoomOwnerAgentTypeForTestsInDatabase(
  database: Database,
  chatJid: string,
  ownerAgentType: AgentType | null,
): void {
  database
    .prepare(
      `UPDATE room_settings
       SET owner_agent_type = ?,
           updated_at = ?
       WHERE chat_jid = ?`,
    )
    .run(ownerAgentType, new Date().toISOString(), chatJid);
  if (ownerAgentType) {
    const now = new Date().toISOString();
    upsertRoomRoleOverride(database, chatJid, {
      role: 'owner',
      agentType: ownerAgentType,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export function deleteStoredRoomSettingsForTestsInDatabase(
  database: Database,
  chatJid: string,
): void {
  database.prepare('DELETE FROM room_settings WHERE chat_jid = ?').run(chatJid);
}

export function getRegisteredGroupFromDatabase(
  database: Database,
  jid: string,
  agentType?: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const requestedAgentType = normalizeStoredAgentType(agentType);
  const stored = getStoredRoomSettingsRowFromDatabase(database, jid);
  if (!stored) {
    return undefined;
  }

  return buildRegisteredGroupFromStoredSettings(
    database,
    stored,
    requestedAgentType,
  );
}

function seedRoomBindingForTestsInDatabase(
  database: Database,
  jid: string,
  group: RegisteredGroup,
): void {
  const existingStored = getStoredRoomSettingsRowFromDatabase(database, jid);
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }

  database.transaction(() => {
    const seededAgentType = group.agentType || 'claude-code';
    const agentTypes = new Set<AgentType>(
      existingStored
        ? resolveStoredRoomCapabilityTypes(database, existingStored)
        : [],
    );
    agentTypes.add(seededAgentType);
    const inferredRoomMode = inferRoomModeFromRegisteredAgentTypes([
      ...agentTypes,
    ]);
    const roomMode =
      existingStored?.modeSource === 'explicit'
        ? existingStored.roomMode
        : inferredRoomMode;
    const ownerAgentType =
      existingStored?.modeSource === 'explicit' && existingStored.ownerAgentType
        ? existingStored.ownerAgentType
        : inferOwnerAgentTypeFromRegisteredAgentTypes([...agentTypes]);
    const snapshot: RoomRegistrationSnapshot = {
      name: group.name,
      folder: group.folder,
      triggerPattern:
        existingStored?.modeSource === 'explicit' && existingStored.trigger
          ? existingStored.trigger
          : (group.trigger ?? ''),
      requiresTrigger:
        group.requiresTrigger ?? existingStored?.requiresTrigger ?? false,
      isMain: group.isMain ?? existingStored?.isMain ?? false,
      ownerAgentType,
      workDir: group.workDir ?? existingStored?.workDir ?? null,
    };

    if (existingStored) {
      updateStoredRoomMetadata(database, jid, snapshot);
      if (existingStored.modeSource === 'inferred') {
        upsertStoredRoomModeInDatabase(database, jid, roomMode, 'inferred');
      }
    } else {
      insertStoredRoomSettings(database, jid, roomMode, 'inferred', snapshot);
    }

    syncRoomRoleOverridesForRoom(database, jid, roomMode, ownerAgentType, {
      ownerAgentConfig:
        seededAgentType === ownerAgentType ? group.agentConfig : undefined,
      ownerCreatedAt:
        seededAgentType === ownerAgentType ? group.added_at : undefined,
      reviewerAgentConfig:
        roomMode === 'tribunal' && seededAgentType !== ownerAgentType
          ? group.agentConfig
          : undefined,
      reviewerCreatedAt:
        roomMode === 'tribunal' && seededAgentType !== ownerAgentType
          ? group.added_at
          : undefined,
      updatedAt: group.added_at,
    });
  })();
}

export function setRegisteredGroupForTestsInDatabase(
  database: Database,
  jid: string,
  group: RegisteredGroup,
): void {
  seedRoomBindingForTestsInDatabase(database, jid, group);
}

export function assignRoomInDatabase(
  database: Database,
  chatJid: string,
  input: AssignRoomInput,
): (RegisteredGroup & { jid: string }) | undefined {
  const existing = getStoredRoomSettingsRowFromDatabase(database, chatJid);
  const roomMode = input.roomMode || existing?.roomMode || 'single';
  const ownerAgentType =
    input.ownerAgentType || existing?.ownerAgentType || OWNER_AGENT_TYPE;
  const folder = resolveAssignedRoomFolder(
    database,
    chatJid,
    input.name,
    input.folder,
  );
  const snapshot: RoomRegistrationSnapshot = {
    name: input.name,
    folder,
    triggerPattern: existing?.trigger ?? '',
    requiresTrigger: existing?.requiresTrigger ?? false,
    isMain: input.isMain ?? existing?.isMain ?? false,
    ownerAgentType,
    workDir: input.workDir ?? existing?.workDir ?? null,
  };
  const now = new Date().toISOString();

  database.transaction(() => {
    if (existing) {
      database
        .prepare(
          `UPDATE room_settings
           SET room_mode = ?,
               mode_source = 'explicit',
               name = ?,
               folder = ?,
               trigger_pattern = ?,
               requires_trigger = ?,
               is_main = ?,
               owner_agent_type = ?,
               work_dir = ?,
               updated_at = ?
           WHERE chat_jid = ?`,
        )
        .run(
          roomMode,
          snapshot.name,
          snapshot.folder,
          snapshot.triggerPattern,
          snapshot.requiresTrigger ? 1 : 0,
          snapshot.isMain ? 1 : 0,
          snapshot.ownerAgentType,
          snapshot.workDir,
          now,
          chatJid,
        );
    } else {
      insertStoredRoomSettings(
        database,
        chatJid,
        roomMode,
        'explicit',
        snapshot,
      );
    }

    syncRoomRoleOverridesForRoom(database, chatJid, roomMode, ownerAgentType, {
      ownerAgentConfig: input.ownerAgentConfig,
      ownerCreatedAt: input.addedAt ?? now,
      updatedAt: input.addedAt ?? now,
    });
  })();

  return getRegisteredGroupFromDatabase(database, chatJid);
}

export function updateRegisteredGroupNameInDatabase(
  database: Database,
  jid: string,
  name: string,
): void {
  const stored = getStoredRoomSettingsRowFromDatabase(database, jid);
  if (!stored) {
    return;
  }

  updateStoredRoomMetadata(
    database,
    jid,
    buildRoomRegistrationSnapshotFromStoredRoom(database, stored, { name }),
  );
}

export function getAllRoomBindingsFromDatabase(
  database: Database,
  agentTypeFilter?: string,
): Record<string, RegisteredGroup> {
  const result: Record<string, RegisteredGroup> = {};
  const requestedAgentType = normalizeStoredAgentType(agentTypeFilter);
  const storedRows = getStoredRoomRowsFromDatabase(database);

  for (const stored of storedRows) {
    const group = buildRegisteredGroupFromStoredSettings(
      database,
      stored,
      requestedAgentType,
    );
    if (!group) continue;
    const { jid, ...rest } = group;
    result[jid] = rest;
  }

  return result;
}

export function getRegisteredAgentTypesForJidFromDatabase(
  database: Database,
  jid: string,
): AgentType[] {
  const stored = getStoredRoomSettingsRowFromDatabase(database, jid);
  return stored ? resolveStoredRoomCapabilityTypes(database, stored) : [];
}

export function getStoredRoomSettingsFromDatabase(
  database: Database,
  chatJid: string,
): StoredRoomSettings | undefined {
  return getStoredRoomSettingsRowFromDatabase(database, chatJid);
}

function getStoredRoomModeRowFromDatabase(
  database: Database,
  chatJid: string,
): StoredRoomModeRow | undefined {
  const row = getStoredRoomSettingsFromDatabase(database, chatJid);
  return row
    ? {
        roomMode: row.roomMode,
        source: row.modeSource,
      }
    : undefined;
}

function buildRoomRegistrationSnapshotFromStoredRoom(
  database: Database,
  stored: StoredRoomSettings,
  overrides?: Partial<Pick<RoomRegistrationSnapshot, 'name'>>,
): RoomRegistrationSnapshot {
  const capabilityTypes = resolveStoredRoomCapabilityTypes(database, stored);
  const ownerAgentType =
    stored.ownerAgentType ||
    (capabilityTypes.length > 0
      ? inferOwnerAgentTypeFromRegisteredAgentTypes(capabilityTypes)
      : OWNER_AGENT_TYPE);
  const name = overrides?.name ?? stored.name ?? stored.chatJid;

  return {
    name,
    folder: resolveAssignedRoomFolder(
      database,
      stored.chatJid,
      name,
      stored.folder,
    ),
    triggerPattern: stored.trigger ?? '',
    requiresTrigger: stored.requiresTrigger ?? false,
    isMain: stored.isMain ?? false,
    ownerAgentType,
    workDir: stored.workDir ?? null,
  };
}

function upsertStoredRoomModeInDatabase(
  database: Database,
  chatJid: string,
  roomMode: RoomMode,
  source: RoomModeSource,
): void {
  database
    .prepare(
      `INSERT INTO room_settings (
        chat_jid,
        room_mode,
        mode_source,
        updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_jid) DO UPDATE SET
        room_mode = excluded.room_mode,
        mode_source = excluded.mode_source,
        updated_at = excluded.updated_at`,
    )
    .run(chatJid, roomMode, source, new Date().toISOString());
}

export function getExplicitRoomModeFromDatabase(
  database: Database,
  chatJid: string,
): RoomMode | undefined {
  const row = getStoredRoomModeRowFromDatabase(database, chatJid);
  return row?.source === 'explicit' ? row.roomMode : undefined;
}

export function setExplicitRoomModeInDatabase(
  database: Database,
  chatJid: string,
  roomMode: RoomMode,
): void {
  upsertStoredRoomModeInDatabase(database, chatJid, roomMode, 'explicit');
}

export function clearExplicitRoomModeInDatabase(
  database: Database,
  chatJid: string,
): void {
  const stored = getStoredRoomSettingsRowFromDatabase(database, chatJid);
  if (!stored) {
    return;
  }

  const agentTypes = inferStoredRoomCapabilityTypes(database, stored);
  if (agentTypes.length === 0) {
    database
      .prepare('DELETE FROM room_settings WHERE chat_jid = ?')
      .run(chatJid);
    database
      .prepare('DELETE FROM room_role_overrides WHERE chat_jid = ?')
      .run(chatJid);
    return;
  }

  upsertStoredRoomModeInDatabase(
    database,
    chatJid,
    inferRoomModeFromRegisteredAgentTypes(agentTypes),
    'inferred',
  );
}

export function getEffectiveRoomModeFromDatabase(
  database: Database,
  chatJid: string,
): RoomMode {
  return (
    getStoredRoomModeRowFromDatabase(database, chatJid)?.roomMode ?? 'single'
  );
}

export function getEffectiveRuntimeRoomModeFromDatabase(
  database: Database,
  chatJid: string,
): RoomMode {
  return (
    getStoredRoomSettingsFromDatabase(database, chatJid)?.roomMode ?? 'single'
  );
}
