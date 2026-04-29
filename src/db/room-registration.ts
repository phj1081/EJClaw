import { Database } from 'bun:sqlite';

import {
  ARBITER_AGENT_TYPE,
  OWNER_AGENT_TYPE,
  REVIEWER_AGENT_TYPE,
} from '../config.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  type RoleAgentPlan,
  resolveRoleAgentPlan,
} from '../role-agent-plan.js';
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

export interface RoomRoleOverrideSnapshot {
  role: 'owner' | 'reviewer' | 'arbiter';
  agentType: AgentType;
  agentConfig?: RegisteredGroup['agentConfig'];
  createdAt: string;
  updatedAt: string;
}

interface StoredRoomRoleOverrideRow {
  role: 'owner' | 'reviewer' | 'arbiter';
  agentType: AgentType;
  agentConfig?: RegisteredGroup['agentConfig'];
  createdAt: string;
  updatedAt: string;
}

export interface LegacyRoomMigrationPlan {
  chatJid: string;
  roomMode: RoomMode;
  createdAt: string;
  updatedAt: string;
  snapshot: RoomRegistrationSnapshot;
  roleOverrides: RoomRoleOverrideSnapshot[];
}

export interface SyncRoomRoleOverridesOptions {
  ownerAgentConfig?: RegisteredGroup['agentConfig'];
  ownerCreatedAt?: string;
  reviewerAgentType?: AgentType;
  reviewerAgentConfig?: RegisteredGroup['agentConfig'];
  reviewerCreatedAt?: string;
  arbiterAgentType?: AgentType | null;
  arbiterAgentConfig?: RegisteredGroup['agentConfig'];
  arbiterCreatedAt?: string;
  updatedAt?: string;
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

function getStoredRoomRoleOverrideRows(
  database: Database,
  jid: string,
): Map<'owner' | 'reviewer' | 'arbiter', StoredRoomRoleOverrideRow> {
  let rows: Array<{
    role: 'owner' | 'reviewer' | 'arbiter';
    agent_type: string | null;
    agent_config_json: string | null;
    created_at: string;
    updated_at: string;
  }>;
  try {
    rows = database
      .prepare(
        `SELECT role, agent_type, agent_config_json, created_at, updated_at
           FROM room_role_overrides
          WHERE chat_jid = ?`,
      )
      .all(jid) as Array<{
      role: 'owner' | 'reviewer' | 'arbiter';
      agent_type: string | null;
      agent_config_json: string | null;
      created_at: string;
      updated_at: string;
    }>;
  } catch {
    return new Map();
  }

  const result = new Map<
    'owner' | 'reviewer' | 'arbiter',
    StoredRoomRoleOverrideRow
  >();
  for (const row of rows) {
    const agentType = normalizeStoredAgentType(row.agent_type);
    if (!agentType) continue;
    result.set(row.role, {
      role: row.role,
      agentType,
      agentConfig: row.agent_config_json
        ? JSON.parse(row.agent_config_json)
        : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  return result;
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

export function resolveStoredRoomRoleAgentPlan(
  database: Database,
  stored: StoredRoomSettings,
): RoleAgentPlan {
  const overrides = getStoredRoomRoleOverrideRows(database, stored.chatJid);
  const ownerAgentType =
    stored.ownerAgentType ??
    overrides.get('owner')?.agentType ??
    OWNER_AGENT_TYPE;

  return resolveRoleAgentPlan({
    paired: stored.roomMode === 'tribunal',
    groupAgentType: ownerAgentType,
    configuredReviewer:
      overrides.get('reviewer')?.agentType ?? REVIEWER_AGENT_TYPE,
    configuredArbiter:
      overrides.get('arbiter')?.agentType ?? ARBITER_AGENT_TYPE,
  });
}

export function buildRegisteredGroupFromStoredSettings(
  database: Database,
  stored: StoredRoomSettings,
  requestedAgentType?: AgentType,
): (RegisteredGroup & { jid: string }) | undefined {
  const capabilityTypes = resolveStoredRoomCapabilityTypes(database, stored);
  const rolePlan = resolveStoredRoomRoleAgentPlan(database, stored);
  const ownerAgentType =
    rolePlan.ownerAgentType ||
    (capabilityTypes.length > 0
      ? inferOwnerAgentTypeFromRegisteredAgentTypes(capabilityTypes)
      : undefined);
  const resolvedAgentType = requestedAgentType
    ? capabilityTypes.includes(requestedAgentType)
      ? requestedAgentType
      : undefined
    : ownerAgentType;

  if (!resolvedAgentType) return undefined;
  if (!stored.folder || !isValidGroupFolder(stored.folder)) {
    logger.warn(
      { jid: stored.chatJid, folder: stored.folder ?? null },
      'Skipping stored room with invalid folder',
    );
    return undefined;
  }

  const role: 'owner' | 'reviewer' | 'arbiter' =
    ownerAgentType === resolvedAgentType
      ? 'owner'
      : rolePlan.reviewerAgentType === resolvedAgentType
        ? 'reviewer'
        : 'arbiter';
  const capabilityMetadata = getStoredRoomRoleOverrideRows(
    database,
    stored.chatJid,
  ).get(role);

  return {
    jid: stored.chatJid,
    name: stored.name || stored.chatJid,
    folder: stored.folder,
    trigger: stored.trigger,
    added_at: capabilityMetadata?.createdAt || new Date(0).toISOString(),
    agentConfig: capabilityMetadata?.agentConfig,
    requiresTrigger: stored.requiresTrigger ?? false,
    isMain: stored.isMain ? true : undefined,
    agentType: resolvedAgentType,
    workDir: stored.workDir,
  };
}

export function inferStoredRoomCapabilityTypes(
  database: Database,
  stored: StoredRoomSettings,
): AgentType[] {
  const overrides = getStoredRoomRoleOverrideRows(database, stored.chatJid);
  const inferredTypes = new Set<AgentType>();
  for (const override of overrides.values()) {
    inferredTypes.add(override.agentType);
  }
  if (inferredTypes.size === 0 && stored.ownerAgentType) {
    inferredTypes.add(stored.ownerAgentType);
  }
  return [...inferredTypes];
}

export function resolveStoredRoomCapabilityTypes(
  database: Database,
  stored: StoredRoomSettings,
): AgentType[] {
  if (stored.modeSource !== 'explicit') {
    return inferStoredRoomCapabilityTypes(database, stored);
  }

  const rolePlan = resolveStoredRoomRoleAgentPlan(database, stored);
  const types = new Set<AgentType>([rolePlan.ownerAgentType]);
  if (stored.roomMode === 'tribunal' && rolePlan.reviewerAgentType) {
    types.add(rolePlan.reviewerAgentType);
  }
  if (stored.roomMode === 'tribunal' && rolePlan.arbiterAgentType) {
    types.add(rolePlan.arbiterAgentType);
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
         AND (? IS NULL OR chat_jid != ?)`,
    )
    .all(exceptChatJid ?? null, exceptChatJid ?? null) as Array<{
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

export function insertStoredRoomSettings(
  database: Database,
  chatJid: string,
  roomMode: RoomMode,
  source: RoomModeSource,
  snapshot: RoomRegistrationSnapshot,
): void {
  const now = new Date().toISOString();
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
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      now,
      now,
    );
}

export function insertStoredRoomSettingsFromMigration(
  database: Database,
  plan: LegacyRoomMigrationPlan,
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
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_jid) DO NOTHING`,
    )
    .run(
      plan.chatJid,
      plan.roomMode,
      'inferred',
      plan.snapshot.name,
      plan.snapshot.folder,
      plan.snapshot.triggerPattern,
      plan.snapshot.requiresTrigger ? 1 : 0,
      plan.snapshot.isMain ? 1 : 0,
      plan.snapshot.ownerAgentType,
      plan.snapshot.workDir,
      plan.createdAt,
      plan.updatedAt,
    );
}

export function upsertRoomRoleOverride(
  database: Database,
  chatJid: string,
  override: RoomRoleOverrideSnapshot,
): void {
  database
    .prepare(
      `INSERT INTO room_role_overrides (
        chat_jid,
        role,
        agent_type,
        agent_config_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_jid, role) DO UPDATE SET
        agent_type = excluded.agent_type,
        agent_config_json = excluded.agent_config_json,
        updated_at = excluded.updated_at`,
    )
    .run(
      chatJid,
      override.role,
      override.agentType,
      override.agentConfig ? JSON.stringify(override.agentConfig) : null,
      override.createdAt,
      override.updatedAt,
    );
}

export function syncRoomRoleOverridesForRoom(
  database: Database,
  chatJid: string,
  roomMode: RoomMode,
  ownerAgentType: AgentType,
  options: SyncRoomRoleOverridesOptions = {},
): void {
  const now = options.updatedAt ?? new Date().toISOString();
  const existingOverrides = getStoredRoomRoleOverrideRows(database, chatJid);
  const existingOwnerOverride = existingOverrides.get('owner');
  upsertRoomRoleOverride(database, chatJid, {
    role: 'owner',
    agentType: ownerAgentType,
    agentConfig:
      options.ownerAgentConfig ??
      (existingOwnerOverride?.agentType === ownerAgentType
        ? existingOwnerOverride.agentConfig
        : undefined),
    createdAt:
      (existingOwnerOverride?.agentType === ownerAgentType
        ? existingOwnerOverride.createdAt
        : undefined) ??
      options.ownerCreatedAt ??
      now,
    updatedAt: now,
  });

  if (roomMode === 'tribunal') {
    const existingReviewerOverride = existingOverrides.get('reviewer');
    const previousDefaultReviewerAgentType =
      existingOwnerOverride?.agentType === REVIEWER_AGENT_TYPE
        ? OWNER_AGENT_TYPE
        : REVIEWER_AGENT_TYPE;
    const computedReviewerAgentType =
      ownerAgentType === REVIEWER_AGENT_TYPE
        ? OWNER_AGENT_TYPE
        : REVIEWER_AGENT_TYPE;
    const reviewerAgentType =
      options.reviewerAgentType ??
      (existingReviewerOverride &&
      existingReviewerOverride.agentType !== previousDefaultReviewerAgentType
        ? existingReviewerOverride.agentType
        : computedReviewerAgentType);
    upsertRoomRoleOverride(database, chatJid, {
      role: 'reviewer',
      agentType: reviewerAgentType,
      agentConfig:
        options.reviewerAgentConfig ??
        (existingReviewerOverride?.agentType === reviewerAgentType
          ? existingReviewerOverride.agentConfig
          : undefined),
      createdAt:
        (existingReviewerOverride?.agentType === reviewerAgentType
          ? existingReviewerOverride.createdAt
          : undefined) ??
        options.reviewerCreatedAt ??
        now,
      updatedAt: now,
    });

    const existingArbiterOverride = existingOverrides.get('arbiter');
    const arbiterAgentType =
      options.arbiterAgentType ??
      existingArbiterOverride?.agentType ??
      ARBITER_AGENT_TYPE ??
      null;

    if (arbiterAgentType) {
      upsertRoomRoleOverride(database, chatJid, {
        role: 'arbiter',
        agentType: arbiterAgentType,
        agentConfig:
          options.arbiterAgentConfig ??
          (existingArbiterOverride?.agentType === arbiterAgentType
            ? existingArbiterOverride.agentConfig
            : undefined),
        createdAt:
          (existingArbiterOverride?.agentType === arbiterAgentType
            ? existingArbiterOverride.createdAt
            : undefined) ??
          options.arbiterCreatedAt ??
          now,
        updatedAt: now,
      });
    } else {
      database
        .prepare(
          `DELETE FROM room_role_overrides
           WHERE chat_jid = ?
             AND role = 'arbiter'`,
        )
        .run(chatJid);
    }
  } else {
    database
      .prepare(
        `DELETE FROM room_role_overrides
         WHERE chat_jid = ?
           AND role = 'reviewer'`,
      )
      .run(chatJid);
    database
      .prepare(
        `DELETE FROM room_role_overrides
         WHERE chat_jid = ?
           AND role = 'arbiter'`,
      )
      .run(chatJid);
  }
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
