import { Database } from 'bun:sqlite';

import { storeMessage } from '../../src/db.js';
import { initializeDatabaseSchema } from '../../src/db/bootstrap.js';
import {
  type RoomRegistrationSnapshot,
  type RoomRoleOverrideSnapshot,
  type StoredRoomSettings,
  getStoredRoomSettingsRowFromDatabase,
  inferOwnerAgentTypeFromRegisteredAgentTypes,
  inferRoomModeFromRegisteredAgentTypes,
  insertStoredRoomSettingsFromMigration,
  normalizeStoredAgentType,
  upsertRoomRoleOverride,
} from '../../src/db/room-registration.js';
import { OWNER_AGENT_TYPE } from '../../src/config.js';
import type { AgentType } from '../../src/types.js';

// Helper to store a message using the normalized NewMessage interface
export function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

export function insertPairedTurnIdentityRow(
  database: Database,
  args: {
    turnId: string;
    taskId: string;
    taskUpdatedAt: string;
    role: 'owner' | 'reviewer' | 'arbiter';
    intentKind:
      | 'owner-turn'
      | 'reviewer-turn'
      | 'arbiter-turn'
      | 'owner-follow-up'
      | 'finalize-owner-turn';
    createdAt: string;
    updatedAt: string;
  },
): void {
  database
    .prepare(
      `
        INSERT INTO paired_turns (
          turn_id,
          task_id,
          task_updated_at,
          role,
          intent_kind,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      args.turnId,
      args.taskId,
      args.taskUpdatedAt,
      args.role,
      args.intentKind,
      args.createdAt,
      args.updatedAt,
    );
}

type LegacyRoomMigrationPlanForTests = Parameters<
  typeof insertStoredRoomSettingsFromMigration
>[1];

function getStoredRoleOverridesForLegacyMigration(
  database: Database,
  jid: string,
): Map<
  'owner' | 'reviewer' | 'arbiter',
  {
    role: 'owner' | 'reviewer' | 'arbiter';
    agentType: AgentType;
    agentConfig?: unknown;
    createdAt: string;
    updatedAt: string;
  }
> {
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
    {
      role: 'owner' | 'reviewer' | 'arbiter';
      agentType: AgentType;
      agentConfig?: unknown;
      createdAt: string;
      updatedAt: string;
    }
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

function collectLegacyRoomRegistrationSnapshotForTests(
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

  const agentTypes = new Set<AgentType>();
  for (const row of rows) {
    const agentType = normalizeStoredAgentType(row.agent_type);
    if (agentType) {
      agentTypes.add(agentType);
    }
  }
  const inferredOwnerAgentType = inferOwnerAgentTypeFromRegisteredAgentTypes([
    ...agentTypes,
  ]);
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
    ) ?? rows[0]!;
  const ownerAgentType = preferredOwnerAgentType ?? inferredOwnerAgentType;
  const ownerRow = preferredOwnerRow ?? inferredOwnerRow;

  return {
    name: first.name,
    folder: first.folder,
    triggerPattern: preferExplicitTrigger
      ? existingStored.trigger!
      : (preferredOwnerRow?.trigger_pattern ?? ownerRow.trigger_pattern),
    requiresTrigger: (first.requires_trigger ?? 1) === 1,
    isMain: (first.is_main ?? 0) === 1,
    ownerAgentType,
    workDir: first.work_dir ?? null,
  };
}

function buildLegacyRoomMigrationPlanForTests(
  database: Database,
  jid: string,
): LegacyRoomMigrationPlanForTests | undefined {
  const existingStored = getStoredRoomSettingsRowFromDatabase(database, jid);
  const snapshot = collectLegacyRoomRegistrationSnapshotForTests(
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

  const agentTypes = (
    database
      .prepare(
        `SELECT agent_type
           FROM registered_groups
          WHERE jid = ?`,
      )
      .all(jid) as Array<{ agent_type: string | null }>
  )
    .map((row) => normalizeStoredAgentType(row.agent_type))
    .filter((value): value is AgentType => Boolean(value));
  const roomMode =
    existingStored?.roomMode ??
    inferRoomModeFromRegisteredAgentTypes(agentTypes);
  const createdAt = rows[0]!.added_at;
  const updatedAt = rows[rows.length - 1]!.added_at;
  const roleOverrides: RoomRoleOverrideSnapshot[] = [];

  const getCapabilityMetadata = (preferredAgentType?: AgentType) =>
    (preferredAgentType
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
          .get(jid, OWNER_AGENT_TYPE)) as
      | { added_at: string; agent_config: string | null }
      | undefined;

  const ownerMetadata = getCapabilityMetadata(snapshot.ownerAgentType);
  roleOverrides.push({
    role: 'owner',
    agentType: snapshot.ownerAgentType,
    agentConfig: ownerMetadata?.agent_config
      ? JSON.parse(ownerMetadata.agent_config)
      : undefined,
    createdAt: ownerMetadata?.added_at ?? createdAt,
    updatedAt,
  });

  if (roomMode === 'tribunal') {
    const reviewerAgentType = agentTypes.find(
      (agentType) => agentType !== snapshot.ownerAgentType,
    );
    if (!reviewerAgentType) {
      throw new Error(
        `Missing reviewer agent type for tribunal legacy room ${jid}`,
      );
    }
    const reviewerMetadata = getCapabilityMetadata(reviewerAgentType);
    roleOverrides.push({
      role: 'reviewer',
      agentType: reviewerAgentType,
      agentConfig: reviewerMetadata?.agent_config
        ? JSON.parse(reviewerMetadata.agent_config)
        : undefined,
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

export function getPendingLegacyRegisteredGroupJidsForTests(
  database: Database,
): string[] {
  const rows = database
    .prepare(
      `SELECT DISTINCT jid
         FROM registered_groups
        ORDER BY jid`,
    )
    .all() as Array<{ jid: string }>;

  return rows
    .map((row) => row.jid)
    .filter((jid) => {
      const stored = getStoredRoomSettingsRowFromDatabase(database, jid);
      if (!stored) {
        return true;
      }

      const plan = buildLegacyRoomMigrationPlanForTests(database, jid);
      if (!plan) {
        return false;
      }
      if (
        stored.name !== plan.snapshot.name ||
        stored.folder !== plan.snapshot.folder ||
        (stored.requiresTrigger ?? true) !== plan.snapshot.requiresTrigger ||
        (stored.isMain ?? false) !== plan.snapshot.isMain ||
        (stored.workDir ?? null) !== (plan.snapshot.workDir ?? null)
      ) {
        return true;
      }

      const existingOverrides = getStoredRoleOverridesForLegacyMigration(
        database,
        jid,
      );
      return plan.roleOverrides.some((override) => {
        const actual = existingOverrides.get(override.role);
        return (
          actual?.agentType !== override.agentType ||
          JSON.stringify(actual?.agentConfig ?? null) !==
            JSON.stringify(override.agentConfig ?? null)
        );
      });
    });
}

export function migrateLegacyRoomRegistrationsInFile(dbPath: string): {
  migratedRooms: number;
  migratedRoleOverrides: number;
} {
  const migrationDb = new Database(dbPath);
  let migratedRooms = 0;
  let migratedRoleOverrides = 0;

  try {
    initializeDatabaseSchema(migrationDb);
    migrationDb.transaction(() => {
      const rows = getPendingLegacyRegisteredGroupJidsForTests(migrationDb).map(
        (jid) => ({ jid }),
      );

      for (const row of rows) {
        const plan = buildLegacyRoomMigrationPlanForTests(migrationDb, row.jid);
        if (!plan) continue;
        const existing = migrationDb
          .prepare('SELECT 1 FROM room_settings WHERE chat_jid = ?')
          .get(row.jid);
        if (!existing) {
          insertStoredRoomSettingsFromMigration(migrationDb, plan);
          migratedRooms += 1;
        }
        for (const override of plan.roleOverrides) {
          upsertRoomRoleOverride(migrationDb, row.jid, override);
          migratedRoleOverrides += 1;
        }
      }
      migrationDb.exec(`DROP TABLE IF EXISTS registered_groups`);
    })();
  } finally {
    migrationDb.close();
  }

  return { migratedRooms, migratedRoleOverrides };
}
