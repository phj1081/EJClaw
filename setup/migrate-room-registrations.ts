import fs from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

import { DATA_DIR, STORE_DIR } from '../src/config.js';
import {
  initializeDatabaseSchema,
  openPersistentDatabase,
} from '../src/db/bootstrap.js';
import {
  buildLegacyRoomMigrationPlan,
  getPendingLegacyRegisteredGroupJids,
  getStoredRoomSettingsRowFromDatabase,
  insertStoredRoomSettingsFromMigration,
  normalizeStoredAgentType,
  upsertRoomRoleOverride,
} from '../src/db/room-registration.js';
import type { RegisteredGroup } from '../src/types.js';
import { isValidGroupFolder } from '../src/group-folder.js';
import { logger } from '../src/logger.js';
import { readJsonFile } from '../src/utils.js';
import { emitStatus } from './status.js';

interface MigrationReport {
  migratedRooms: number;
  migratedRoleOverrides: number;
  skippedRooms: number;
  migratedJsonRooms: number;
  skippedJsonRooms: number;
  backedUpLegacyRows: number;
  renamedLegacyJson: boolean;
}

interface StoredOwnerRoleOverride {
  agentType: string;
  agentConfig?: RegisteredGroup['agentConfig'];
}

function normalizeAgentConfigValue(
  agentConfig: RegisteredGroup['agentConfig'] | undefined,
): string {
  return JSON.stringify(agentConfig ?? null);
}

function jsonEntryMatchesStoredRoom(
  jid: string,
  group: RegisteredGroup,
  database: Database,
): boolean {
  const existing = getStoredRoomSettingsRowFromDatabase(database, jid);
  if (!existing) {
    return false;
  }

  const ownerAgentType =
    normalizeStoredAgentType(group.agentType) ?? 'claude-code';
  return (
    existing.roomMode === 'single' &&
    existing.name === group.name &&
    existing.folder === group.folder &&
    existing.trigger === group.trigger &&
    (existing.requiresTrigger ?? true) === (group.requiresTrigger ?? true) &&
    (existing.isMain ?? false) === (group.isMain ?? false) &&
    existing.ownerAgentType === ownerAgentType &&
    (existing.workDir ?? null) === (group.workDir ?? null)
  );
}

function getStoredOwnerRoleOverride(
  database: Database,
  jid: string,
): StoredOwnerRoleOverride | undefined {
  try {
    const row = database
      .prepare(
        `SELECT agent_type, agent_config_json
           FROM room_role_overrides
          WHERE chat_jid = ?
            AND role = 'owner'`,
      )
      .get(jid) as
      | {
          agent_type: string | null;
          agent_config_json: string | null;
        }
      | undefined;
    const agentType = normalizeStoredAgentType(row?.agent_type);
    if (!agentType) {
      return undefined;
    }
    return {
      agentType,
      agentConfig: row?.agent_config_json
        ? JSON.parse(row.agent_config_json)
        : undefined,
    };
  } catch {
    return undefined;
  }
}

function jsonEntryMatchesStoredOwnerOverride(
  database: Database,
  jid: string,
  group: RegisteredGroup,
): boolean {
  const existingOverride = getStoredOwnerRoleOverride(database, jid);
  if (!existingOverride) {
    return false;
  }

  const ownerAgentType =
    normalizeStoredAgentType(group.agentType) ?? 'claude-code';
  return (
    existingOverride.agentType === ownerAgentType &&
    normalizeAgentConfigValue(existingOverride.agentConfig) ===
      normalizeAgentConfigValue(group.agentConfig)
  );
}

function ensureLegacyBackupTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS registered_groups_legacy_backup (
      jid TEXT NOT NULL,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      agent_config TEXT,
      requires_trigger INTEGER,
      is_main INTEGER,
      agent_type TEXT,
      work_dir TEXT,
      backup_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (jid, agent_type)
    )
  `);
}

function backupPendingLegacyRows(database: Database): number {
  ensureLegacyBackupTable(database);
  const pendingJids = new Set(getPendingLegacyRegisteredGroupJids(database));
  if (pendingJids.size === 0) {
    return 0;
  }
  const rows = (
    database
      .prepare(
        `SELECT jid, name, folder, trigger_pattern, added_at, agent_config,
                requires_trigger, is_main, agent_type, work_dir
           FROM registered_groups`,
      )
      .all() as Array<Record<string, unknown>>
  ).filter((row) => pendingJids.has(String(row.jid)));

  const insert = database.prepare(
    `INSERT OR REPLACE INTO registered_groups_legacy_backup (
      jid,
      name,
      folder,
      trigger_pattern,
      added_at,
      agent_config,
      requires_trigger,
      is_main,
      agent_type,
      work_dir,
      backup_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  );

  for (const row of rows) {
    insert.run(
      row.jid,
      row.name,
      row.folder,
      row.trigger_pattern,
      row.added_at,
      row.agent_config ?? null,
      row.requires_trigger ?? null,
      row.is_main ?? null,
      row.agent_type ?? null,
      row.work_dir ?? null,
    );
  }

  return rows.length;
}

function migrateLegacyRegisteredGroupsTable(
  database: Database,
  report: MigrationReport,
): void {
  const rows = getPendingLegacyRegisteredGroupJids(database).map((jid) => ({
    jid,
  }));

  for (const row of rows) {
    const plan = buildLegacyRoomMigrationPlan(database, row.jid);
    if (!plan) {
      report.skippedRooms += 1;
      continue;
    }

    const existing = database
      .prepare('SELECT 1 FROM room_settings WHERE chat_jid = ?')
      .get(row.jid);
    if (!existing) {
      insertStoredRoomSettingsFromMigration(database, plan);
      report.migratedRooms += 1;
    }
    for (const override of plan.roleOverrides) {
      upsertRoomRoleOverride(database, row.jid, override);
      report.migratedRoleOverrides += 1;
    }
  }
}

function loadValidatedLegacyRegisteredGroupsJson(
  database: Database,
): Array<{ jid: string; group: RegisteredGroup }> {
  const legacyJsonPath = path.join(DATA_DIR, 'registered_groups.json');
  const legacyJson = readJsonFile(legacyJsonPath) as Record<
    string,
    RegisteredGroup
  > | null;

  if (!legacyJson) {
    return [];
  }

  const entries = Object.entries(legacyJson);
  for (const [jid, group] of entries) {
    if (!isValidGroupFolder(group.folder)) {
      throw new Error(
        `Invalid legacy registered_groups.json folder for ${jid}: ${group.folder}`,
      );
    }

    const existing = getStoredRoomSettingsRowFromDatabase(database, jid);
    if (existing && !jsonEntryMatchesStoredRoom(jid, group, database)) {
      throw new Error(
        `Legacy registered_groups.json entry collides with existing room_settings row for ${jid}`,
      );
    }
  }

  return entries.map(([jid, group]) => ({ jid, group }));
}

function migrateLegacyRegisteredGroupsJson(
  database: Database,
  projectRoot: string,
  report: MigrationReport,
): void {
  const legacyJsonPath = path.join(DATA_DIR, 'registered_groups.json');
  const legacyJsonEntries = loadValidatedLegacyRegisteredGroupsJson(database);
  if (legacyJsonEntries.length === 0) {
    return;
  }

  const insertRoom = database.prepare(
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
  );

  for (const { jid, group } of legacyJsonEntries) {
    const createdAt = group.added_at || new Date().toISOString();
    const ownerAgentType =
      normalizeStoredAgentType(group.agentType) ?? 'claude-code';
    const existing = getStoredRoomSettingsRowFromDatabase(database, jid);
    const existingOwnerOverride = getStoredOwnerRoleOverride(database, jid);

    if (!existing) {
      insertRoom.run(
        jid,
        'single',
        'inferred',
        group.name,
        group.folder,
        group.trigger,
        (group.requiresTrigger ?? true) ? 1 : 0,
        (group.isMain ?? false) ? 1 : 0,
        ownerAgentType,
        group.workDir ?? null,
        createdAt,
        createdAt,
      );
      report.migratedRooms += 1;
      report.migratedJsonRooms += 1;
    }

    if (
      existingOwnerOverride &&
      !jsonEntryMatchesStoredOwnerOverride(database, jid, group)
    ) {
      throw new Error(
        `Legacy registered_groups.json owner override conflicts with existing owner override for ${jid}`,
      );
    }

    if (!existingOwnerOverride) {
      upsertRoomRoleOverride(database, jid, {
        role: 'owner',
        agentType: ownerAgentType,
        agentConfig: group.agentConfig,
        createdAt,
        updatedAt: createdAt,
      });
      report.migratedRoleOverrides += 1;
    }
  }

  fs.renameSync(legacyJsonPath, `${legacyJsonPath}.migrated`);
  report.renamedLegacyJson = true;
  logger.info(
    { legacyJsonPath, projectRoot },
    'Renamed registered_groups.json after explicit migration',
  );
}

export async function run(_args: string[]): Promise<void> {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const projectRoot = process.cwd();
  const database = openPersistentDatabase();
  initializeDatabaseSchema(database);

  const report: MigrationReport = {
    migratedRooms: 0,
    migratedRoleOverrides: 0,
    skippedRooms: 0,
    migratedJsonRooms: 0,
    skippedJsonRooms: 0,
    backedUpLegacyRows: 0,
    renamedLegacyJson: false,
  };

  database.transaction(() => {
    report.backedUpLegacyRows = backupPendingLegacyRows(database);
    migrateLegacyRegisteredGroupsTable(database, report);
    migrateLegacyRegisteredGroupsJson(database, projectRoot, report);
  })();

  database.close();

  emitStatus('MIGRATE_ROOM_REGISTRATIONS', {
    MIGRATED_ROOMS: report.migratedRooms,
    MIGRATED_ROLE_OVERRIDES: report.migratedRoleOverrides,
    SKIPPED_ROOMS: report.skippedRooms,
    MIGRATED_JSON_ROOMS: report.migratedJsonRooms,
    SKIPPED_JSON_ROOMS: report.skippedJsonRooms,
    BACKED_UP_LEGACY_ROWS: report.backedUpLegacyRows,
    RENAMED_LEGACY_JSON: report.renamedLegacyJson,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
