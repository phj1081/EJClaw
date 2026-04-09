import { Database } from 'bun:sqlite';

import {
  ASSISTANT_NAME,
  OWNER_AGENT_TYPE,
  REVIEWER_AGENT_TYPE,
} from '../config.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import type { AgentType, RegisteredGroup, RoomMode } from '../types.js';

export type RoomModeSource = 'explicit' | 'inferred';

export interface StoredRoomSettings {
  chatJid: string;
  roomMode: RoomMode;
  modeSource: RoomModeSource;
  name?: string;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
  ownerAgentType?: AgentType;
  workDir?: string;
}

export interface RoomRegistrationSnapshot {
  name: string;
  folder: string;
  triggerPattern: string;
  requiresTrigger: boolean;
  isMain: boolean;
  ownerAgentType: AgentType;
  workDir: string | null;
}

export interface RegisteredGroupDatabaseRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  agent_config: string | null;
  requires_trigger: number | null;
  is_main: number | null;
  agent_type: string | null;
  work_dir: string | null;
}

export function normalizeRoomModeSource(
  source: string | null | undefined,
): RoomModeSource | undefined {
  return source === 'explicit' || source === 'inferred' ? source : undefined;
}

export function normalizeStoredAgentType(
  agentType: string | null | undefined,
): AgentType | undefined {
  return agentType === 'claude-code' || agentType === 'codex'
    ? agentType
    : undefined;
}

export function collectRegisteredAgentTypes(
  database: Database,
  jid: string,
): AgentType[] {
  const rows = database
    .prepare('SELECT agent_type FROM registered_groups WHERE jid = ?')
    .all(jid) as Array<{ agent_type: string | null }>;

  const types = new Set<AgentType>();
  for (const row of rows) {
    const agentType = normalizeStoredAgentType(row.agent_type);
    if (agentType) {
      types.add(agentType);
    }
  }
  return [...types];
}

export function collectRegisteredAgentTypesForFolder(
  database: Database,
  folder: string,
): AgentType[] {
  const rows = database
    .prepare('SELECT agent_type FROM registered_groups WHERE folder = ?')
    .all(folder) as Array<{ agent_type: string | null }>;

  const types = new Set<AgentType>();
  for (const row of rows) {
    const agentType = normalizeStoredAgentType(row.agent_type);
    if (agentType) {
      types.add(agentType);
    }
  }
  return [...types];
}

export function inferRoomModeFromRegisteredAgentTypes(
  agentTypes: readonly AgentType[],
): RoomMode {
  const types = new Set(agentTypes);
  return types.has('claude-code') && types.has('codex') ? 'tribunal' : 'single';
}

export function inferOwnerAgentTypeFromRegisteredAgentTypes(
  agentTypes: readonly AgentType[],
): AgentType {
  const types = new Set(agentTypes);
  if (types.has(OWNER_AGENT_TYPE)) return OWNER_AGENT_TYPE;
  if (types.has('codex')) return 'codex';
  return 'claude-code';
}

export function parseRegisteredGroupRow(
  row: RegisteredGroupDatabaseRow | undefined,
): (RegisteredGroup & { jid: string }) | undefined {
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }

  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    agentConfig: row.agent_config ? JSON.parse(row.agent_config) : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    agentType: normalizeStoredAgentType(row.agent_type),
    workDir: row.work_dir || undefined,
  };
}

export function getLegacyRegisteredGroupRows(
  database: Database,
  agentTypeFilter?: string,
): RegisteredGroupDatabaseRow[] {
  return (
    agentTypeFilter
      ? database
          .prepare(
            `SELECT *
             FROM registered_groups
             WHERE agent_type = ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM room_settings
                 WHERE chat_jid = registered_groups.jid
               )`,
          )
          .all(agentTypeFilter)
      : database
          .prepare(
            `SELECT *
             FROM registered_groups
             WHERE NOT EXISTS (
               SELECT 1
               FROM room_settings
               WHERE chat_jid = registered_groups.jid
             )`,
          )
          .all()
  ) as RegisteredGroupDatabaseRow[];
}

export function getLegacyRegisteredGroup(
  database: Database,
  jid: string,
  agentType?: string,
): (RegisteredGroup & { jid: string }) | undefined {
  if (getStoredRoomSettingsRowFromDatabase(database, jid)) {
    return undefined;
  }

  const row = (
    agentType
      ? database
          .prepare(
            'SELECT * FROM registered_groups WHERE jid = ? AND agent_type = ?',
          )
          .get(jid, agentType)
      : database
          .prepare('SELECT * FROM registered_groups WHERE jid = ?')
          .get(jid)
  ) as RegisteredGroupDatabaseRow | undefined;

  return parseRegisteredGroupRow(row);
}

export function getRegisteredGroupCapabilityMetadata(
  database: Database,
  jid: string,
  preferredAgentType?: AgentType,
): Pick<RegisteredGroup, 'added_at' | 'agentConfig'> | undefined {
  const row = (
    preferredAgentType
      ? database
          .prepare(
            `SELECT added_at, agent_config
             FROM registered_groups
             WHERE jid = ? AND agent_type = ?
             LIMIT 1`,
          )
          .get(jid, preferredAgentType)
      : database
          .prepare(
            `SELECT added_at, agent_config
             FROM registered_groups
             WHERE jid = ?
             ORDER BY CASE WHEN agent_type = ? THEN 0 ELSE 1 END, added_at
             LIMIT 1`,
          )
          .get(jid, OWNER_AGENT_TYPE)
  ) as { added_at: string; agent_config: string | null } | undefined;

  if (!row) return undefined;
  return {
    added_at: row.added_at,
    agentConfig: row.agent_config ? JSON.parse(row.agent_config) : undefined,
  };
}

export function getStoredRoomSettingsRowFromDatabase(
  database: Database,
  chatJid: string,
): StoredRoomSettings | undefined {
  const row = database
    .prepare(
      `SELECT room_mode, mode_source, name, folder, trigger_pattern,
              requires_trigger, is_main, owner_agent_type, work_dir
       FROM room_settings
       WHERE chat_jid = ?`,
    )
    .get(chatJid) as
    | {
        room_mode: string | null;
        mode_source: string | null;
        name: string | null;
        folder: string | null;
        trigger_pattern: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        owner_agent_type: string | null;
        work_dir: string | null;
      }
    | undefined;
  const roomMode =
    row?.room_mode === 'single' || row?.room_mode === 'tribunal'
      ? row.room_mode
      : undefined;
  const source = normalizeRoomModeSource(row?.mode_source);
  if (!row || !roomMode || !source) return undefined;

  return {
    chatJid,
    roomMode,
    modeSource: source,
    name: row.name ?? undefined,
    folder: row.folder ?? undefined,
    trigger: row.trigger_pattern ?? undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === null ? undefined : row.is_main === 1,
    ownerAgentType: normalizeStoredAgentType(row.owner_agent_type),
    workDir: row.work_dir ?? undefined,
  };
}

export function getStoredRoomRowsFromDatabase(
  database: Database,
): StoredRoomSettings[] {
  return database
    .prepare(
      `SELECT chat_jid
       FROM room_settings
       ORDER BY chat_jid`,
    )
    .all()
    .map((row) =>
      getStoredRoomSettingsRowFromDatabase(
        database,
        (row as { chat_jid: string }).chat_jid,
      ),
    )
    .filter((row): row is StoredRoomSettings => Boolean(row));
}

export function buildRegisteredGroupFromStoredSettings(
  database: Database,
  stored: StoredRoomSettings,
  requestedAgentType?: AgentType,
): (RegisteredGroup & { jid: string }) | undefined {
  const capabilityTypes = resolveStoredRoomCapabilityTypes(database, stored);
  const resolvedAgentType = requestedAgentType
    ? capabilityTypes.includes(requestedAgentType)
      ? requestedAgentType
      : undefined
    : stored.ownerAgentType ||
      (capabilityTypes.length > 0
        ? inferOwnerAgentTypeFromRegisteredAgentTypes(capabilityTypes)
        : undefined);

  if (!resolvedAgentType) return undefined;
  if (!stored.folder || !isValidGroupFolder(stored.folder)) {
    logger.warn(
      { jid: stored.chatJid, folder: stored.folder ?? null },
      'Skipping stored room with invalid folder',
    );
    return undefined;
  }

  const capabilityMetadata = getRegisteredGroupCapabilityMetadata(
    database,
    stored.chatJid,
    resolvedAgentType,
  );

  return {
    jid: stored.chatJid,
    name: stored.name || stored.chatJid,
    folder: stored.folder,
    trigger: stored.trigger || `@${ASSISTANT_NAME}`,
    added_at: capabilityMetadata?.added_at || new Date(0).toISOString(),
    agentConfig: capabilityMetadata?.agentConfig,
    requiresTrigger: stored.requiresTrigger,
    isMain: stored.isMain ? true : undefined,
    agentType: resolvedAgentType,
    workDir: stored.workDir,
  };
}

export function resolveStoredRoomCapabilityTypes(
  database: Database,
  stored: StoredRoomSettings,
): AgentType[] {
  const projectedTypes = collectRegisteredAgentTypes(database, stored.chatJid);
  if (stored.modeSource !== 'explicit') {
    return projectedTypes;
  }

  const ownerAgentType =
    stored.ownerAgentType ||
    (projectedTypes.length > 0
      ? inferOwnerAgentTypeFromRegisteredAgentTypes(projectedTypes)
      : OWNER_AGENT_TYPE);
  const types = new Set<AgentType>([ownerAgentType]);
  if (stored.roomMode === 'tribunal') {
    types.add(REVIEWER_AGENT_TYPE);
  }
  return [...types];
}

function detectChannelPrefixForFolder(chatJid: string): string {
  if (chatJid.startsWith('dc:')) return 'discord';
  if (chatJid.startsWith('tg:')) return 'telegram';
  return 'whatsapp';
}

function slugifyGroupFolderSegment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'room';
}

function collectReservedFolders(
  database: Database,
  exceptChatJid?: string,
): Set<string> {
  const folders = new Set<string>();
  const rows = database
    .prepare(
      `SELECT folder
       FROM room_settings
       WHERE folder IS NOT NULL
         AND (? IS NULL OR chat_jid != ?)
       UNION
       SELECT folder
       FROM registered_groups
       WHERE ? IS NULL OR jid != ?`,
    )
    .all(
      exceptChatJid ?? null,
      exceptChatJid ?? null,
      exceptChatJid ?? null,
      exceptChatJid ?? null,
    ) as Array<{
    folder: string | null;
  }>;

  for (const row of rows) {
    if (row.folder) folders.add(row.folder);
  }
  return folders;
}

function buildGeneratedRoomFolder(
  database: Database,
  chatJid: string,
  name: string,
): string {
  const prefix = detectChannelPrefixForFolder(chatJid);
  const slug = slugifyGroupFolderSegment(name);
  const fallback = slugifyGroupFolderSegment(chatJid.replace(/[:@.]/g, '-'));
  const baseCore = slug || fallback;
  const maxBaseLength = 64 - (`grp_${prefix}_`.length + 4);
  const truncatedCore = baseCore.slice(0, Math.max(8, maxBaseLength));
  const candidateBase = `grp_${prefix}_${truncatedCore}`;
  const reserved = collectReservedFolders(database, chatJid);

  if (!reserved.has(candidateBase) && isValidGroupFolder(candidateBase)) {
    return candidateBase;
  }

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${candidateBase.slice(0, Math.max(1, 64 - `${suffix}`.length - 1))}-${suffix}`;
    if (!reserved.has(candidate) && isValidGroupFolder(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to generate unique group folder for ${chatJid}`);
}

export function resolveAssignedRoomFolder(
  database: Database,
  chatJid: string,
  name: string,
  explicitFolder?: string,
): string {
  const reserved = collectReservedFolders(database, chatJid);
  if (explicitFolder) {
    if (!isValidGroupFolder(explicitFolder)) {
      throw new Error(
        `Invalid group folder "${explicitFolder}" for JID ${chatJid}`,
      );
    }
    if (reserved.has(explicitFolder)) {
      throw new Error(`Group folder "${explicitFolder}" is already assigned`);
    }
    return explicitFolder;
  }

  const existingFolder = getStoredRoomSettingsRowFromDatabase(
    database,
    chatJid,
  )?.folder;
  if (existingFolder) return existingFolder;

  return buildGeneratedRoomFolder(database, chatJid, name);
}

function getDesiredRegisteredAgentTypes(
  roomMode: RoomMode,
  ownerAgentType: AgentType,
): AgentType[] {
  const types = new Set<AgentType>([ownerAgentType]);
  if (roomMode === 'tribunal') {
    types.add(REVIEWER_AGENT_TYPE);
  }
  return [...types];
}

export function materializeRegisteredGroupsForRoom(
  database: Database,
  chatJid: string,
  snapshot: RoomRegistrationSnapshot,
  roomMode: RoomMode,
  ownerAgentType: AgentType,
  ownerAgentConfig?: RegisteredGroup['agentConfig'],
  addedAt?: string,
): void {
  const now = new Date().toISOString();
  const desiredTypes = getDesiredRegisteredAgentTypes(roomMode, ownerAgentType);
  const existingRows = database
    .prepare(
      `SELECT agent_type, added_at, agent_config
       FROM registered_groups
       WHERE jid = ?`,
    )
    .all(chatJid) as Array<{
    agent_type: string | null;
    added_at: string;
    agent_config: string | null;
  }>;
  const existingByType = new Map<
    AgentType,
    { added_at: string; agent_config: string | null }
  >();
  for (const row of existingRows) {
    const agentType = normalizeStoredAgentType(row.agent_type);
    if (agentType) {
      existingByType.set(agentType, row);
    }
  }

  for (const agentType of desiredTypes) {
    const existing = existingByType.get(agentType);
    const agentConfig =
      agentType === ownerAgentType
        ? (ownerAgentConfig ??
          (existing?.agent_config
            ? JSON.parse(existing.agent_config)
            : undefined))
        : existing?.agent_config
          ? JSON.parse(existing.agent_config)
          : undefined;
    const rowAddedAt = existing?.added_at ?? addedAt ?? now;

    database
      .prepare(
        `INSERT OR REPLACE INTO registered_groups (
          jid,
          name,
          folder,
          trigger_pattern,
          added_at,
          agent_config,
          requires_trigger,
          is_main,
          agent_type,
          work_dir
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chatJid,
        snapshot.name,
        snapshot.folder,
        snapshot.triggerPattern,
        rowAddedAt,
        agentConfig ? JSON.stringify(agentConfig) : null,
        snapshot.requiresTrigger ? 1 : 0,
        snapshot.isMain ? 1 : 0,
        agentType,
        snapshot.workDir,
      );
  }

  const placeholders = desiredTypes.map(() => '?').join(',');
  database
    .prepare(
      `DELETE FROM registered_groups
       WHERE jid = ?
         AND agent_type NOT IN (${placeholders})`,
    )
    .run(chatJid, ...desiredTypes);
}

export function collectRoomRegistrationSnapshot(
  database: Database,
  jid: string,
  existingStored?: Pick<
    StoredRoomSettings,
    'modeSource' | 'ownerAgentType' | 'trigger'
  >,
): RoomRegistrationSnapshot | undefined {
  const rows = database
    .prepare(
      `SELECT name, folder, trigger_pattern, requires_trigger, is_main, agent_type, work_dir
       FROM registered_groups
       WHERE jid = ?
       ORDER BY agent_type`,
    )
    .all(jid) as Array<{
    name: string;
    folder: string;
    trigger_pattern: string;
    requires_trigger: number | null;
    is_main: number | null;
    agent_type: string | null;
    work_dir: string | null;
  }>;

  if (rows.length === 0) return undefined;

  const first = rows[0];
  const conflicts = new Set<string>();
  for (const row of rows.slice(1)) {
    if (row.name !== first.name) conflicts.add('name');
    if (row.folder !== first.folder) conflicts.add('folder');
    if ((row.requires_trigger ?? 1) !== (first.requires_trigger ?? 1)) {
      conflicts.add('requires_trigger');
    }
    if ((row.is_main ?? 0) !== (first.is_main ?? 0)) {
      conflicts.add('is_main');
    }
    if ((row.work_dir ?? null) !== (first.work_dir ?? null)) {
      conflicts.add('work_dir');
    }
  }

  if (conflicts.size > 0) {
    throw new Error(
      `Conflicting room-level registered_groups metadata for ${jid}: ${[
        ...conflicts,
      ].join(', ')}`,
    );
  }

  const agentTypes = collectRegisteredAgentTypes(database, jid);
  const inferredOwnerAgentType =
    inferOwnerAgentTypeFromRegisteredAgentTypes(agentTypes);
  const preferExplicitTrigger =
    existingStored?.modeSource === 'explicit' && existingStored.trigger;
  const preferExplicitOwner =
    existingStored?.modeSource === 'explicit' && existingStored.ownerAgentType;
  const preferredOwnerAgentType = preferExplicitOwner
    ? existingStored.ownerAgentType
    : undefined;
  const preferredOwnerRow = preferredOwnerAgentType
    ? rows.find(
        (row) =>
          normalizeStoredAgentType(row.agent_type) === preferredOwnerAgentType,
      )
    : undefined;
  const inferredOwnerRow =
    rows.find(
      (row) =>
        normalizeStoredAgentType(row.agent_type) === inferredOwnerAgentType,
    ) ?? rows[0];
  const ownerAgentType = preferredOwnerAgentType
    ? preferredOwnerRow
      ? preferredOwnerAgentType
      : preferredOwnerAgentType
    : inferredOwnerAgentType;
  const ownerRow = preferredOwnerRow ?? inferredOwnerRow;

  return {
    name: first.name,
    folder: first.folder,
    triggerPattern: preferExplicitTrigger
      ? existingStored.trigger!
      : preferredOwnerRow != null
        ? preferredOwnerRow.trigger_pattern
        : ownerRow.trigger_pattern,
    requiresTrigger: (first.requires_trigger ?? 1) === 1,
    isMain: (first.is_main ?? 0) === 1,
    ownerAgentType,
    workDir: first.work_dir ?? null,
  };
}

export function insertStoredRoomSettings(
  database: Database,
  chatJid: string,
  roomMode: RoomMode,
  source: RoomModeSource,
  snapshot: RoomRegistrationSnapshot,
): void {
  database
    .prepare(
      `INSERT INTO room_settings (
        chat_jid,
        room_mode,
        mode_source,
        name,
        folder,
        trigger_pattern,
        requires_trigger,
        is_main,
        owner_agent_type,
        work_dir,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chatJid,
      roomMode,
      source,
      snapshot.name,
      snapshot.folder,
      snapshot.triggerPattern,
      snapshot.requiresTrigger ? 1 : 0,
      snapshot.isMain ? 1 : 0,
      snapshot.ownerAgentType,
      snapshot.workDir,
      new Date().toISOString(),
    );
}

export function updateStoredRoomMetadata(
  database: Database,
  chatJid: string,
  snapshot: RoomRegistrationSnapshot,
): void {
  database
    .prepare(
      `UPDATE room_settings
       SET name = ?,
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
      snapshot.name,
      snapshot.folder,
      snapshot.triggerPattern,
      snapshot.requiresTrigger ? 1 : 0,
      snapshot.isMain ? 1 : 0,
      snapshot.ownerAgentType,
      snapshot.workDir,
      new Date().toISOString(),
      chatJid,
    );
}
