import fs from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

import { STORE_DIR } from '../src/config.js';
import { listUnexpectedDataStateFiles } from '../src/data-state-files.js';
import { countPendingLegacyRegisteredGroupRows } from './legacy-room-registrations.js';

export interface AssignedRoomsSummary {
  assignedRooms: number;
  roomsByOwnerAgent: Record<string, number>;
  legacyRegisteredGroupRows: number;
  legacyRoomMigrationRequired: boolean;
  unexpectedDataStateFiles: string[];
  unexpectedDataStateDetected: boolean;
}

export interface RoomRegistrationGateFailure {
  error: string;
  nextStep: string;
}

function getDataDir(projectRoot: string): string {
  return process.env.EJCLAW_DATA_DIR || path.join(projectRoot, 'data');
}

export function getRoomRegistrationGateFailure(
  summary: Pick<
    AssignedRoomsSummary,
    'legacyRoomMigrationRequired' | 'unexpectedDataStateDetected'
  >,
  target: 'setup' | 'verification',
): RoomRegistrationGateFailure | undefined {
  if (
    !summary.legacyRoomMigrationRequired &&
    !summary.unexpectedDataStateDetected
  ) {
    return undefined;
  }

  const error =
    summary.legacyRoomMigrationRequired && summary.unexpectedDataStateDetected
      ? 'legacy_migration_and_unexpected_data_state_detected'
      : summary.legacyRoomMigrationRequired
        ? 'legacy_room_migration_required'
        : 'unexpected_data_state_files_detected';
  const nextStep =
    summary.legacyRoomMigrationRequired && summary.unexpectedDataStateDetected
      ? `Run \`bun setup/index.ts --step migrate-room-registrations\` and remove or archive unexpected data state files before continuing with ${target}`
      : summary.legacyRoomMigrationRequired
        ? `Run \`bun setup/index.ts --step migrate-room-registrations\` before continuing with ${target}`
        : `Remove or archive unexpected data state files before continuing with ${target}`;

  return {
    error,
    nextStep,
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

  const unexpectedDataStateFiles = listUnexpectedDataStateFiles(
    getDataDir(projectRoot),
  );
  const legacyRoomMigrationRequired = legacyRegisteredGroupRows > 0;
  const unexpectedDataStateDetected = unexpectedDataStateFiles.length > 0;

  return {
    assignedRooms,
    roomsByOwnerAgent,
    legacyRegisteredGroupRows,
    legacyRoomMigrationRequired,
    unexpectedDataStateFiles,
    unexpectedDataStateDetected,
  };
}
