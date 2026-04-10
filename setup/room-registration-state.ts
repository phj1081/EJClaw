import fs from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

import { STORE_DIR } from '../src/config.js';
import { countPendingLegacyRegisteredGroupRows } from '../src/db/room-registration.js';

export interface AssignedRoomsSummary {
  assignedRooms: number;
  roomsByOwnerAgent: Record<string, number>;
  legacyRegisteredGroupRows: number;
  hasLegacyRegisteredGroupsJson: boolean;
  legacyRoomMigrationRequired: boolean;
  pendingLegacyJsonStateFiles: string[];
  legacyJsonStateMigrationRequired: boolean;
}

export interface LegacyMigrationGuidance {
  error: string;
  nextStep: string;
}

function getDataDir(projectRoot: string): string {
  return process.env.EJCLAW_DATA_DIR || path.join(projectRoot, 'data');
}

function getPendingLegacyJsonStateFiles(projectRoot: string): string[] {
  const dataDir = getDataDir(projectRoot);
  return ['router_state.json', 'sessions.json'].filter((filename) =>
    fs.existsSync(path.join(dataDir, filename)),
  );
}

export function getLegacyMigrationGuidance(
  summary: Pick<
    AssignedRoomsSummary,
    'legacyRoomMigrationRequired' | 'legacyJsonStateMigrationRequired'
  >,
  target: 'setup' | 'verification',
): LegacyMigrationGuidance | undefined {
  if (
    !summary.legacyRoomMigrationRequired &&
    !summary.legacyJsonStateMigrationRequired
  ) {
    return undefined;
  }

  const steps: string[] = [];
  if (summary.legacyRoomMigrationRequired) {
    steps.push('bun setup/index.ts --step migrate-room-registrations');
  }
  if (summary.legacyJsonStateMigrationRequired) {
    steps.push('bun setup/index.ts --step migrate-json-state');
  }

  const error =
    summary.legacyRoomMigrationRequired &&
    summary.legacyJsonStateMigrationRequired
      ? 'legacy_migration_required'
      : summary.legacyRoomMigrationRequired
        ? 'legacy_room_migration_required'
        : 'legacy_json_state_migration_required';
  const commandText =
    steps.length === 1
      ? `Run \`${steps[0]}\` before continuing with ${target}`
      : `Run \`${steps[0]}\` and \`${steps[1]}\` before continuing with ${target}`;

  return {
    error,
    nextStep: commandText,
  };
}

export function detectRoomRegistrationState(
  options: {
    projectRoot?: string;
    dbPath?: string;
  } = {},
): AssignedRoomsSummary {
  const projectRoot = options.projectRoot ?? process.cwd();
  const dbPath = options.dbPath ?? path.join(STORE_DIR, 'messages.db');
  let assignedRooms = 0;
  let legacyRegisteredGroupRows = 0;
  const roomsByOwnerAgent: Record<string, number> = {};

  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });

      try {
        const row = db
          .prepare('SELECT COUNT(*) as count FROM room_settings')
          .get() as { count: number };
        assignedRooms = row.count;
      } catch {
        assignedRooms = 0;
      }

      if (assignedRooms > 0) {
        try {
          const rows = db
            .prepare(
              `SELECT COALESCE(owner_agent_type, 'unknown') AS owner_agent_type,
                      COUNT(*) AS count
                 FROM room_settings
                GROUP BY COALESCE(owner_agent_type, 'unknown')`,
            )
            .all() as { owner_agent_type: string; count: number }[];
          for (const current of rows) {
            roomsByOwnerAgent[current.owner_agent_type] = current.count;
          }
        } catch {
          // room_settings might not exist in older schema
        }
      }

      try {
        legacyRegisteredGroupRows = countPendingLegacyRegisteredGroupRows(db);
      } catch {
        legacyRegisteredGroupRows = 0;
      }

      db.close();
    } catch {
      // Database might not exist yet or schema might be incomplete
    }
  }

  const hasLegacyRegisteredGroupsJson = fs.existsSync(
    path.join(getDataDir(projectRoot), 'registered_groups.json'),
  );
  const pendingLegacyJsonStateFiles =
    getPendingLegacyJsonStateFiles(projectRoot);
  const legacyRoomMigrationRequired =
    legacyRegisteredGroupRows > 0 || hasLegacyRegisteredGroupsJson;
  const legacyJsonStateMigrationRequired =
    pendingLegacyJsonStateFiles.length > 0;

  return {
    assignedRooms,
    roomsByOwnerAgent,
    legacyRegisteredGroupRows,
    hasLegacyRegisteredGroupsJson,
    legacyRoomMigrationRequired,
    pendingLegacyJsonStateFiles,
    legacyJsonStateMigrationRequired,
  };
}
