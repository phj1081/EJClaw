import fs from 'fs';

import { Database } from 'bun:sqlite';

import { DATA_DIR, STORE_DIR } from '../src/config.js';
import { listUnexpectedDataStateFiles } from '../src/data-state-files.js';
import {
  initializeDatabaseSchema,
  openPersistentDatabase,
} from '../src/db/bootstrap.js';
import {
  insertStoredRoomSettingsFromMigration,
  upsertRoomRoleOverride,
} from '../src/db/room-registration.js';
import {
  buildLegacyRoomMigrationPlan,
  getPendingLegacyRegisteredGroupJids,
  normalizeLegacyRegisteredGroupsTable,
} from './legacy-room-registrations.js';
import { emitStatus } from './status.js';

interface MigrationReport {
  migratedRooms: number;
  migratedRoleOverrides: number;
  skippedRooms: number;
  backedUpLegacyRows: number;
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

function backupLegacyRows(database: Database): number {
  const tableExists = database
    .prepare(
      `SELECT 1
         FROM sqlite_master
        WHERE type = 'table'
          AND name = 'registered_groups'`,
    )
    .get();
  if (!tableExists) {
    return 0;
  }

  ensureLegacyBackupTable(database);
  const rows = database
    .prepare(
      `SELECT jid, name, folder, trigger_pattern, added_at, agent_config,
              requires_trigger, is_main, agent_type, work_dir
         FROM registered_groups`,
    )
    .all() as Array<{
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
  }>;

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

function dropLegacyRegisteredGroupsTable(database: Database): void {
  database.exec(`DROP TABLE IF EXISTS registered_groups`);
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

export async function run(_args: string[]): Promise<void> {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const unexpectedDataStateFiles = listUnexpectedDataStateFiles(DATA_DIR);
  if (unexpectedDataStateFiles.length > 0) {
    throw new Error(
      `Unexpected data state files detected before room migration (files=${unexpectedDataStateFiles.join(',')})`,
    );
  }

  const database = openPersistentDatabase();
  initializeDatabaseSchema(database);

  const report: MigrationReport = {
    migratedRooms: 0,
    migratedRoleOverrides: 0,
    skippedRooms: 0,
    backedUpLegacyRows: 0,
  };

  database.transaction(() => {
    normalizeLegacyRegisteredGroupsTable(database);
    report.backedUpLegacyRows = backupLegacyRows(database);
    migrateLegacyRegisteredGroupsTable(database, report);
    dropLegacyRegisteredGroupsTable(database);
  })();

  database.close();

  emitStatus('MIGRATE_ROOM_REGISTRATIONS', {
    MIGRATED_ROOMS: report.migratedRooms,
    MIGRATED_ROLE_OVERRIDES: report.migratedRoleOverrides,
    SKIPPED_ROOMS: report.skippedRooms,
    BACKED_UP_LEGACY_ROWS: report.backedUpLegacyRows,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
