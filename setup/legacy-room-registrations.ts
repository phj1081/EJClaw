import { Database } from 'bun:sqlite';

import { OWNER_AGENT_TYPE } from '../src/config.js';
import type { AgentType, RegisteredGroup } from '../src/types.js';
import {
  type LegacyRoomMigrationPlan,
  type RoomRegistrationSnapshot,
  type RoomRoleOverrideSnapshot,
  type StoredRoomSettings,
  getStoredRoomSettingsRowFromDatabase,
  inferOwnerAgentTypeFromRegisteredAgentTypes,
  inferRoomModeFromRegisteredAgentTypes,
  normalizeStoredAgentType,
} from '../src/db/room-registration.js';

interface StoredRoomRoleOverrideRow {
  role: 'owner' | 'reviewer' | 'arbiter';
  agentType: AgentType;
  agentConfig?: RegisteredGroup['agentConfig'];
  createdAt: string;
  updatedAt: string;
}

function hasLegacyRegisteredGroupsTable(database: Database): boolean {
  const row = database
    .prepare(
      `SELECT 1
         FROM sqlite_master
        WHERE type = 'table'
          AND name = 'registered_groups'`,
    )
    .get() as { 1: number } | undefined;
  return Boolean(row);
}

export function normalizeLegacyRegisteredGroupsTable(database: Database): void {
  const roomBindingsSql = (
    database
      .prepare(
        `SELECT sql
           FROM sqlite_master
          WHERE type = 'table'
            AND name = 'registered_groups'`,
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  if (!roomBindingsSql) {
    return;
  }

  if (!roomBindingsSql.includes('PRIMARY KEY (jid, agent_type)')) {
    const legacyCols = database
      .prepare('PRAGMA table_info(registered_groups)')
      .all() as Array<{ name: string }>;
    const hasIsMain = legacyCols.some((col) => col.name === 'is_main');
    const hasAgentType = legacyCols.some((col) => col.name === 'agent_type');
    const hasWorkDir = legacyCols.some((col) => col.name === 'work_dir');
    const hasAgentConfig = legacyCols.some(
      (col) => col.name === 'agent_config',
    );
    const hasContainerConfig = legacyCols.some(
      (col) => col.name === 'container_config',
    );

    database.exec(`
      CREATE TABLE registered_groups_new (
        jid TEXT NOT NULL,
        name TEXT NOT NULL,
        folder TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        agent_config TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0,
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        work_dir TEXT,
        PRIMARY KEY (jid, agent_type),
        UNIQUE (folder, agent_type)
      );
    `);

    database.exec(`
      INSERT INTO registered_groups_new (
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
      )
      SELECT
        jid,
        name,
        folder,
        trigger_pattern,
        added_at,
        ${
          hasAgentConfig
            ? 'agent_config'
            : hasContainerConfig
              ? 'container_config'
              : 'NULL'
        },
        requires_trigger,
        ${hasIsMain ? 'COALESCE(is_main, 0)' : "CASE WHEN folder = 'main' THEN 1 ELSE 0 END"},
        ${hasAgentType ? "COALESCE(agent_type, 'claude-code')" : "'claude-code'"},
        ${hasWorkDir ? 'work_dir' : 'NULL'}
      FROM registered_groups;
    `);

    database.exec(`
      DROP TABLE registered_groups;
      ALTER TABLE registered_groups_new RENAME TO registered_groups;
    `);
  }

  const registeredGroupCols = database
    .prepare('PRAGMA table_info(registered_groups)')
    .all() as Array<{ name: string }>;
  const hasAgentConfig = registeredGroupCols.some(
    (col) => col.name === 'agent_config',
  );
  const hasContainerConfig = registeredGroupCols.some(
    (col) => col.name === 'container_config',
  );
  if (!hasAgentConfig) {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN agent_config TEXT`);
  }
  if (hasContainerConfig) {
    database.exec(
      `UPDATE registered_groups
         SET agent_config = COALESCE(agent_config, container_config)
       WHERE container_config IS NOT NULL`,
    );
  }
  database.exec(
    `UPDATE registered_groups
        SET is_main = 1
      WHERE folder = 'main'
        AND COALESCE(is_main, 0) = 0`,
  );
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

function normalizeAgentConfigValue(
  agentConfig: RegisteredGroup['agentConfig'] | undefined,
): string {
  return JSON.stringify(agentConfig ?? null);
}

function roomRoleOverrideMatches(
  actual: StoredRoomRoleOverrideRow | undefined,
  expected: RoomRoleOverrideSnapshot,
): boolean {
  return (
    actual?.agentType === expected.agentType &&
    normalizeAgentConfigValue(actual.agentConfig) ===
      normalizeAgentConfigValue(expected.agentConfig)
  );
}

function storedRoomSettingsMatchesLegacySnapshot(
  stored: StoredRoomSettings,
  snapshot: RoomRegistrationSnapshot,
): boolean {
  return (
    stored.name === snapshot.name &&
    stored.folder === snapshot.folder &&
    (stored.requiresTrigger ?? true) === snapshot.requiresTrigger &&
    (stored.isMain ?? false) === snapshot.isMain &&
    (stored.workDir ?? null) === (snapshot.workDir ?? null)
  );
}

function collectLegacyRegisteredAgentTypes(
  database: Database,
  jid: string,
): AgentType[] {
  if (!hasLegacyRegisteredGroupsTable(database)) {
    return [];
  }

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

function getLegacyGroupCapabilityMetadata(
  database: Database,
  jid: string,
  preferredAgentType?: AgentType,
): Pick<RegisteredGroup, 'added_at' | 'agentConfig'> | undefined {
  if (!hasLegacyRegisteredGroupsTable(database)) {
    return undefined;
  }

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

function resolveReviewerAgentTypeFromRegisteredAgentTypes(
  agentTypes: readonly AgentType[],
  ownerAgentType: AgentType,
): AgentType | undefined {
  return agentTypes.find((agentType) => agentType !== ownerAgentType);
}

function collectLegacyRoomRegistrationSnapshot(
  database: Database,
  jid: string,
  existingStored?: Pick<
    StoredRoomSettings,
    'modeSource' | 'ownerAgentType' | 'trigger'
  >,
): RoomRegistrationSnapshot | undefined {
  if (!hasLegacyRegisteredGroupsTable(database)) {
    return undefined;
  }

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

  const first = rows[0]!;
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

  const agentTypes = collectLegacyRegisteredAgentTypes(database, jid);
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

export function buildLegacyRoomMigrationPlan(
  database: Database,
  jid: string,
): LegacyRoomMigrationPlan | undefined {
  const existingStored = getStoredRoomSettingsRowFromDatabase(database, jid);
  const snapshot = collectLegacyRoomRegistrationSnapshot(
    database,
    jid,
    existingStored,
  );
  if (!snapshot) return undefined;

  const rows = database
    .prepare(
      `SELECT added_at
         FROM registered_groups
        WHERE jid = ?
        ORDER BY added_at, agent_type`,
    )
    .all(jid) as Array<{ added_at: string }>;
  if (rows.length === 0) return undefined;

  const agentTypes = collectLegacyRegisteredAgentTypes(database, jid);
  const roomMode =
    existingStored?.roomMode ??
    inferRoomModeFromRegisteredAgentTypes(agentTypes);
  const createdAt = rows[0]!.added_at;
  const updatedAt = rows[rows.length - 1]!.added_at;
  const roleOverrides: RoomRoleOverrideSnapshot[] = [];

  const ownerMetadata = getLegacyGroupCapabilityMetadata(
    database,
    jid,
    snapshot.ownerAgentType,
  );
  roleOverrides.push({
    role: 'owner',
    agentType: snapshot.ownerAgentType,
    agentConfig: ownerMetadata?.agentConfig,
    createdAt: ownerMetadata?.added_at ?? createdAt,
    updatedAt,
  });

  if (roomMode === 'tribunal') {
    const reviewerAgentType = resolveReviewerAgentTypeFromRegisteredAgentTypes(
      agentTypes,
      snapshot.ownerAgentType,
    );
    if (!reviewerAgentType) {
      throw new Error(
        `Missing reviewer agent type for tribunal legacy room ${jid}`,
      );
    }
    const reviewerMetadata = getLegacyGroupCapabilityMetadata(
      database,
      jid,
      reviewerAgentType,
    );
    roleOverrides.push({
      role: 'reviewer',
      agentType: reviewerAgentType,
      agentConfig: reviewerMetadata?.agentConfig,
      createdAt: reviewerMetadata?.added_at ?? createdAt,
      updatedAt,
    });
  }

  return {
    chatJid: jid,
    roomMode,
    createdAt,
    updatedAt,
    snapshot,
    roleOverrides,
  };
}

function jidRequiresLegacyRoomMigration(
  database: Database,
  jid: string,
): boolean {
  let stored: StoredRoomSettings | undefined;
  try {
    stored = getStoredRoomSettingsRowFromDatabase(database, jid);
  } catch {
    return true;
  }
  if (!stored) {
    return true;
  }

  let plan: LegacyRoomMigrationPlan | undefined;
  try {
    plan = buildLegacyRoomMigrationPlan(database, jid);
  } catch {
    return true;
  }
  if (!plan) {
    return false;
  }

  if (!storedRoomSettingsMatchesLegacySnapshot(stored, plan.snapshot)) {
    return true;
  }

  const existingOverrides = getStoredRoomRoleOverrideRows(database, jid);
  for (const override of plan.roleOverrides) {
    if (
      !roomRoleOverrideMatches(existingOverrides.get(override.role), override)
    ) {
      return true;
    }
  }

  return false;
}

export function getPendingLegacyRegisteredGroupJids(
  database: Database,
): string[] {
  if (!hasLegacyRegisteredGroupsTable(database)) {
    return [];
  }

  const rows = database
    .prepare(
      `SELECT DISTINCT jid
         FROM registered_groups
        ORDER BY jid`,
    )
    .all() as Array<{ jid: string }>;

  return rows
    .map((row) => row.jid)
    .filter((jid) => jidRequiresLegacyRoomMigration(database, jid));
}

export function countPendingLegacyRegisteredGroupRows(
  database: Database,
): number {
  if (!hasLegacyRegisteredGroupsTable(database)) {
    return 0;
  }

  let count = 0;
  const countRows = database.prepare(
    `SELECT COUNT(*) AS count
       FROM registered_groups
      WHERE jid = ?`,
  );

  for (const jid of getPendingLegacyRegisteredGroupJids(database)) {
    const row = countRows.get(jid) as { count: number };
    count += row.count;
  }

  return count;
}
