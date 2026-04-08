import { Database } from 'bun:sqlite';

import {
  ARBITER_AGENT_TYPE,
  OWNER_AGENT_TYPE,
  REVIEWER_AGENT_TYPE,
  SERVICE_SESSION_SCOPE,
} from '../config.js';
import {
  collectRegisteredAgentTypes,
  collectRegisteredAgentTypesForFolder,
  collectRoomRegistrationSnapshot,
  getStoredRoomSettingsRowFromDatabase,
  inferOwnerAgentTypeFromRegisteredAgentTypes,
  inferRoomModeFromRegisteredAgentTypes,
  insertStoredRoomSettings,
  normalizeStoredAgentType,
  updateStoredRoomMetadata,
} from './room-registration.js';
import { tableHasColumn } from './schema.js';
import {
  inferAgentTypeFromServiceShadow,
  resolveRoleServiceShadow,
} from '../role-service-shadow.js';
import type { AgentType, PairedRoomRole } from '../types.js';

interface StablePairedTaskRowInput {
  chat_jid: string;
  group_folder: string;
  owner_agent_type?: string | null;
}

interface StableLeaseRoleRowInput {
  chat_jid: string;
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  arbiter_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}

interface WorkItemServiceShadowRow {
  id: number;
  agent_type: string;
  service_id: string;
  delivery_role: PairedRoomRole | null;
}

interface LegacyServiceHandoffServiceRow {
  id: number;
  chat_jid: string;
  group_folder: string;
  source_service_id?: string | null;
  target_service_id?: string | null;
  source_role: PairedRoomRole | null;
  source_agent_type?: string | null;
  target_role: PairedRoomRole | null;
  target_agent_type?: string | null;
}

interface LegacyPairedTaskServiceRow {
  id: string;
  chat_jid: string;
  group_folder: string;
  owner_service_id: string;
  reviewer_service_id: string;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}

export function backfillStoredRoomSettings(database: Database): void {
  const rows = database
    .prepare(`SELECT DISTINCT jid FROM registered_groups`)
    .all() as Array<{ jid: string }>;
  if (rows.length === 0) return;

  const tx = database.transaction((registeredRows: Array<{ jid: string }>) => {
    for (const row of registeredRows) {
      const existing = getStoredRoomSettingsRowFromDatabase(database, row.jid);
      const snapshot = collectRoomRegistrationSnapshot(
        database,
        row.jid,
        existing,
      );
      if (!snapshot) continue;

      if (existing) {
        updateStoredRoomMetadata(database, row.jid, snapshot);
        continue;
      }

      insertStoredRoomSettings(
        database,
        row.jid,
        inferRoomModeFromRegisteredAgentTypes(
          collectRegisteredAgentTypes(database, row.jid),
        ),
        'inferred',
        snapshot,
      );
    }
  });
  tx(rows);
}

export function resolveStablePairedTaskOwnerAgentType(
  database: Database,
  task: StablePairedTaskRowInput,
): AgentType | undefined {
  const persistedOwnerAgentType = normalizeStoredAgentType(
    task.owner_agent_type,
  );
  if (persistedOwnerAgentType) {
    return persistedOwnerAgentType;
  }

  const stored = getStoredRoomSettingsRowFromDatabase(database, task.chat_jid);
  if (stored?.ownerAgentType) {
    return stored.ownerAgentType;
  }

  const jidAgentTypes = collectRegisteredAgentTypes(database, task.chat_jid);
  if (jidAgentTypes.length > 0) {
    return inferOwnerAgentTypeFromRegisteredAgentTypes(jidAgentTypes);
  }

  const folderAgentTypes = collectRegisteredAgentTypesForFolder(
    database,
    task.group_folder,
  );
  if (folderAgentTypes.length > 0) {
    return inferOwnerAgentTypeFromRegisteredAgentTypes(folderAgentTypes);
  }

  return undefined;
}

export function resolveStableReviewerAgentType(
  ownerAgentType: AgentType | undefined,
  fallbackReviewerAgentType?: string | null,
): AgentType | null {
  const persistedReviewerAgentType = normalizeStoredAgentType(
    fallbackReviewerAgentType,
  );
  if (persistedReviewerAgentType) {
    return persistedReviewerAgentType;
  }

  if (ownerAgentType) {
    return REVIEWER_AGENT_TYPE !== ownerAgentType
      ? REVIEWER_AGENT_TYPE
      : ownerAgentType;
  }
  return null;
}

export function resolveStableRoomRoleAgentType(
  database: Database,
  input: {
    chatJid: string;
    groupFolder: string;
    role: PairedRoomRole;
  },
): AgentType | null | undefined {
  if (input.role === 'owner') {
    return resolveStablePairedTaskOwnerAgentType(database, {
      chat_jid: input.chatJid,
      group_folder: input.groupFolder,
      owner_agent_type: null,
    });
  }

  if (input.role === 'reviewer') {
    const ownerAgentType = resolveStablePairedTaskOwnerAgentType(database, {
      chat_jid: input.chatJid,
      group_folder: input.groupFolder,
      owner_agent_type: null,
    });
    return resolveStableReviewerAgentType(ownerAgentType, null);
  }

  return ARBITER_AGENT_TYPE ?? null;
}

function resolveStableLeaseOwnerAgentType(
  database: Database,
  row: StableLeaseRoleRowInput,
): AgentType | undefined {
  const persisted = normalizeStoredAgentType(row.owner_agent_type);
  if (persisted) {
    return persisted;
  }
  const stored = getStoredRoomSettingsRowFromDatabase(database, row.chat_jid);
  if (stored?.ownerAgentType) {
    return stored.ownerAgentType;
  }
  return inferAgentTypeFromServiceShadow(row.owner_service_id);
}

function resolveStableLeaseRoleAgentType(
  database: Database,
  row: StableLeaseRoleRowInput,
  role: PairedRoomRole,
): AgentType | null | undefined {
  if (role === 'owner') {
    return resolveStableLeaseOwnerAgentType(database, row);
  }
  if (role === 'reviewer') {
    if (row.reviewer_service_id == null) {
      return null;
    }
    return (
      normalizeStoredAgentType(row.reviewer_agent_type) ??
      inferAgentTypeFromServiceShadow(row.reviewer_service_id) ??
      resolveStableReviewerAgentType(
        resolveStableLeaseOwnerAgentType(database, row),
        null,
      )
    );
  }
  return (
    normalizeStoredAgentType(row.arbiter_agent_type) ??
    (row.arbiter_service_id
      ? inferAgentTypeFromServiceShadow(row.arbiter_service_id)
      : undefined) ??
    ARBITER_AGENT_TYPE ??
    null
  );
}

export function backfillChannelOwnerRoleMetadata(database: Database): void {
  const rows = database
    .prepare(
      `SELECT
         chat_jid,
         owner_service_id,
         reviewer_service_id,
         arbiter_service_id,
         owner_agent_type,
         reviewer_agent_type,
         arbiter_agent_type
       FROM channel_owner`,
    )
    .all() as StableLeaseRoleRowInput[];

  const update = database.prepare(
    `UPDATE channel_owner
     SET owner_service_id = ?,
         reviewer_service_id = ?,
         arbiter_service_id = ?,
         owner_agent_type = ?,
         reviewer_agent_type = ?,
         arbiter_agent_type = ?
     WHERE chat_jid = ?`,
  );

  const tx = database.transaction((leaseRows: StableLeaseRoleRowInput[]) => {
    for (const row of leaseRows) {
      const ownerAgentType = resolveStableLeaseRoleAgentType(
        database,
        row,
        'owner',
      );
      const reviewerAgentType = resolveStableLeaseRoleAgentType(
        database,
        row,
        'reviewer',
      );
      const arbiterAgentType = resolveStableLeaseRoleAgentType(
        database,
        row,
        'arbiter',
      );

      const ownerServiceId =
        resolveRoleServiceShadow('owner', ownerAgentType) ??
        row.owner_service_id ??
        null;
      const reviewerServiceId =
        row.reviewer_service_id == null
          ? null
          : (resolveRoleServiceShadow('reviewer', reviewerAgentType) ??
            row.reviewer_service_id);
      const arbiterServiceId =
        row.arbiter_service_id == null
          ? null
          : (resolveRoleServiceShadow('arbiter', arbiterAgentType) ??
            row.arbiter_service_id);

      if (
        ownerServiceId === row.owner_service_id &&
        reviewerServiceId === row.reviewer_service_id &&
        arbiterServiceId === row.arbiter_service_id &&
        (ownerAgentType ?? null) === (row.owner_agent_type ?? null) &&
        (reviewerAgentType ?? null) === (row.reviewer_agent_type ?? null) &&
        (arbiterAgentType ?? null) === (row.arbiter_agent_type ?? null)
      ) {
        continue;
      }

      update.run(
        ownerServiceId,
        reviewerServiceId,
        arbiterServiceId,
        ownerAgentType ?? null,
        reviewerAgentType ?? null,
        arbiterAgentType ?? null,
        row.chat_jid,
      );
    }
  });

  tx(rows);
}

export function resolveWorkItemServiceShadow(
  agentType: AgentType,
  deliveryRole?: PairedRoomRole | null,
): string {
  return (
    resolveRoleServiceShadow(deliveryRole ?? 'owner', agentType) ??
    SERVICE_SESSION_SCOPE
  );
}

export function backfillWorkItemServiceShadows(database: Database): void {
  const rows = database
    .prepare(
      `SELECT id, agent_type, service_id, delivery_role
       FROM work_items`,
    )
    .all() as WorkItemServiceShadowRow[];

  const update = database.prepare(
    `UPDATE work_items
     SET service_id = ?
     WHERE id = ?`,
  );

  const tx = database.transaction((workItemRows: WorkItemServiceShadowRow[]) => {
    for (const row of workItemRows) {
      const agentType = normalizeStoredAgentType(row.agent_type);
      if (!agentType) {
        continue;
      }
      const normalizedServiceId = resolveWorkItemServiceShadow(
        agentType,
        row.delivery_role,
      );
      if (normalizedServiceId === row.service_id) {
        continue;
      }
      update.run(normalizedServiceId, row.id);
    }
  });

  tx(rows);
}

export function backfillServiceHandoffServiceShadows(
  database: Database,
): void {
  const rows = database
    .prepare(
      `SELECT
         id,
         chat_jid,
         group_folder,
         source_service_id,
         target_service_id,
         source_role,
         source_agent_type,
         target_role,
         target_agent_type
       FROM service_handoffs`,
    )
    .all() as LegacyServiceHandoffServiceRow[];

  const update = database.prepare(
    `UPDATE service_handoffs
     SET source_service_id = ?,
         target_service_id = ?,
         source_agent_type = ?,
         target_agent_type = ?
     WHERE id = ?`,
  );

  const tx = database.transaction(
    (handoffRows: Array<LegacyServiceHandoffServiceRow>) => {
      for (const row of handoffRows) {
        const sourceAgentType =
          normalizeStoredAgentType(row.source_agent_type) ??
          (row.source_role
            ? resolveStableRoomRoleAgentType(database, {
                chatJid: row.chat_jid,
                groupFolder: row.group_folder,
                role: row.source_role,
              })
            : null) ??
          inferAgentTypeFromServiceShadow(row.source_service_id);
        const targetAgentType =
          normalizeStoredAgentType(row.target_agent_type) ??
          (row.target_role
            ? resolveStableRoomRoleAgentType(database, {
                chatJid: row.chat_jid,
                groupFolder: row.group_folder,
                role: row.target_role,
              })
            : null);

        const normalizedSourceServiceId =
          row.source_role != null
            ? (resolveRoleServiceShadow(row.source_role, sourceAgentType) ??
              row.source_service_id)
            : row.source_service_id;
        const normalizedTargetServiceId =
          row.target_role != null
            ? (resolveRoleServiceShadow(row.target_role, targetAgentType) ??
              row.target_service_id)
            : row.target_service_id;

        if (
          normalizedSourceServiceId === row.source_service_id &&
          normalizedTargetServiceId === row.target_service_id &&
          (sourceAgentType ?? null) === (row.source_agent_type ?? null) &&
          (targetAgentType ?? null) === (row.target_agent_type ?? null)
        ) {
          continue;
        }

        update.run(
          normalizedSourceServiceId ?? SERVICE_SESSION_SCOPE,
          normalizedTargetServiceId ?? SERVICE_SESSION_SCOPE,
          sourceAgentType ?? null,
          targetAgentType ?? null,
          row.id,
        );
      }
    },
  );

  tx(rows);
}

export function backfillPairedTaskRoleMetadata(database: Database): void {
  const rows = database
    .prepare(
      `SELECT
         id,
         chat_jid,
         group_folder,
         owner_service_id,
         reviewer_service_id,
         owner_agent_type,
         reviewer_agent_type,
         arbiter_agent_type
       FROM paired_tasks`,
    )
    .all() as LegacyPairedTaskServiceRow[];

  const tx = database.transaction((taskRows: LegacyPairedTaskServiceRow[]) => {
    const update = database.prepare(
      `UPDATE paired_tasks
         SET owner_service_id = ?,
             reviewer_service_id = ?,
             owner_agent_type = ?,
             reviewer_agent_type = ?,
             arbiter_agent_type = ?
         WHERE id = ?`,
    );

    for (const row of taskRows) {
      const ownerAgentType = resolveStablePairedTaskOwnerAgentType(
        database,
        row,
      );
      const reviewerAgentType = resolveStableReviewerAgentType(
        ownerAgentType,
        row.reviewer_agent_type ?? null,
      );
      const arbiterAgentType =
        normalizeStoredAgentType(row.arbiter_agent_type) ??
        ARBITER_AGENT_TYPE ??
        null;

      const ownerServiceId =
        resolveRoleServiceShadow('owner', ownerAgentType) ??
        row.owner_service_id;
      const reviewerServiceId =
        resolveRoleServiceShadow('reviewer', reviewerAgentType) ??
        row.reviewer_service_id;

      update.run(
        ownerServiceId,
        reviewerServiceId,
        ownerAgentType ?? null,
        reviewerAgentType ?? null,
        arbiterAgentType,
        row.id,
      );
    }
  });

  tx(rows);
}

export function rebuildWorkItemsCanonicalSchema(database: Database): void {
  if (!tableHasColumn(database, 'work_items', 'service_id')) {
    return;
  }

  database.exec(`
    CREATE TABLE work_items_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      delivery_role TEXT,
      status TEXT NOT NULL DEFAULT 'produced',
      start_seq INTEGER,
      end_seq INTEGER,
      result_payload TEXT NOT NULL,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_message_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      CHECK (status IN ('produced', 'delivery_retry', 'delivered')),
      CHECK (delivery_role IN ('owner', 'reviewer', 'arbiter') OR delivery_role IS NULL)
    );
    INSERT INTO work_items_new (
      id,
      group_folder,
      chat_jid,
      agent_type,
      delivery_role,
      status,
      start_seq,
      end_seq,
      result_payload,
      delivery_attempts,
      delivery_message_id,
      last_error,
      created_at,
      updated_at,
      delivered_at
    )
    SELECT
      id,
      group_folder,
      chat_jid,
      agent_type,
      delivery_role,
      status,
      start_seq,
      end_seq,
      result_payload,
      delivery_attempts,
      delivery_message_id,
      last_error,
      created_at,
      updated_at,
      delivered_at
    FROM work_items;
    DROP TABLE work_items;
    ALTER TABLE work_items_new RENAME TO work_items;
    CREATE INDEX IF NOT EXISTS idx_work_items_status
      ON work_items(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_work_items_group_agent
      ON work_items(chat_jid, agent_type, delivery_role, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_open
      ON work_items(chat_jid, agent_type, IFNULL(delivery_role, ''))
      WHERE status IN ('produced', 'delivery_retry');
  `);
}

export function rebuildChannelOwnerCanonicalSchema(database: Database): void {
  if (!tableHasColumn(database, 'channel_owner', 'owner_service_id')) {
    return;
  }

  database.exec(`
    CREATE TABLE channel_owner_new (
      chat_jid TEXT PRIMARY KEY,
      owner_agent_type TEXT,
      reviewer_agent_type TEXT,
      arbiter_agent_type TEXT,
      activated_at TEXT,
      reason TEXT,
      CHECK (owner_agent_type IN ('claude-code', 'codex') OR owner_agent_type IS NULL),
      CHECK (reviewer_agent_type IN ('claude-code', 'codex') OR reviewer_agent_type IS NULL),
      CHECK (arbiter_agent_type IN ('claude-code', 'codex') OR arbiter_agent_type IS NULL)
    );
    INSERT INTO channel_owner_new (
      chat_jid,
      owner_agent_type,
      reviewer_agent_type,
      arbiter_agent_type,
      activated_at,
      reason
    )
    SELECT
      chat_jid,
      owner_agent_type,
      reviewer_agent_type,
      arbiter_agent_type,
      activated_at,
      reason
    FROM channel_owner;
    DROP TABLE channel_owner;
    ALTER TABLE channel_owner_new RENAME TO channel_owner;
  `);
}

export function rebuildPairedTasksCanonicalSchema(database: Database): void {
  if (!tableHasColumn(database, 'paired_tasks', 'owner_service_id')) {
    return;
  }

  database.exec(`
    CREATE TABLE paired_tasks_new (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      owner_agent_type TEXT,
      reviewer_agent_type TEXT,
      arbiter_agent_type TEXT,
      title TEXT,
      source_ref TEXT,
      plan_notes TEXT,
      review_requested_at TEXT,
      round_trip_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      arbiter_verdict TEXT,
      arbiter_requested_at TEXT,
      completion_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (status IN ('active', 'review_ready', 'in_review', 'merge_ready', 'completed', 'arbiter_requested', 'in_arbitration')),
      CHECK (owner_agent_type IN ('claude-code', 'codex') OR owner_agent_type IS NULL),
      CHECK (reviewer_agent_type IN ('claude-code', 'codex') OR reviewer_agent_type IS NULL),
      CHECK (arbiter_agent_type IN ('claude-code', 'codex') OR arbiter_agent_type IS NULL)
    );
    INSERT INTO paired_tasks_new (
      id,
      chat_jid,
      group_folder,
      owner_agent_type,
      reviewer_agent_type,
      arbiter_agent_type,
      title,
      source_ref,
      plan_notes,
      review_requested_at,
      round_trip_count,
      status,
      arbiter_verdict,
      arbiter_requested_at,
      completion_reason,
      created_at,
      updated_at
    )
    SELECT
      id,
      chat_jid,
      group_folder,
      owner_agent_type,
      reviewer_agent_type,
      arbiter_agent_type,
      title,
      source_ref,
      plan_notes,
      review_requested_at,
      round_trip_count,
      status,
      arbiter_verdict,
      arbiter_requested_at,
      completion_reason,
      created_at,
      updated_at
    FROM paired_tasks;
    DROP TABLE paired_tasks;
    ALTER TABLE paired_tasks_new RENAME TO paired_tasks;
    CREATE INDEX IF NOT EXISTS idx_paired_tasks_chat_status
      ON paired_tasks(chat_jid, status, updated_at);
  `);
}

export function rebuildServiceHandoffsCanonicalSchema(
  database: Database,
): void {
  if (!tableHasColumn(database, 'service_handoffs', 'source_service_id')) {
    return;
  }

  database.exec(`
    CREATE TABLE service_handoffs_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      source_role TEXT,
      source_agent_type TEXT,
      target_role TEXT,
      target_agent_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      start_seq INTEGER,
      end_seq INTEGER,
      reason TEXT,
      intended_role TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
      CHECK (intended_role IN ('owner', 'reviewer', 'arbiter') OR intended_role IS NULL),
      CHECK (source_role IN ('owner', 'reviewer', 'arbiter') OR source_role IS NULL),
      CHECK (target_role IN ('owner', 'reviewer', 'arbiter') OR target_role IS NULL),
      CHECK (source_agent_type IN ('claude-code', 'codex') OR source_agent_type IS NULL)
    );
    INSERT INTO service_handoffs_new (
      id,
      chat_jid,
      group_folder,
      source_role,
      source_agent_type,
      target_role,
      target_agent_type,
      prompt,
      status,
      start_seq,
      end_seq,
      reason,
      intended_role,
      created_at,
      claimed_at,
      completed_at,
      last_error
    )
    SELECT
      id,
      chat_jid,
      group_folder,
      source_role,
      source_agent_type,
      target_role,
      target_agent_type,
      prompt,
      status,
      start_seq,
      end_seq,
      reason,
      intended_role,
      created_at,
      claimed_at,
      completed_at,
      last_error
    FROM service_handoffs;
    DROP TABLE service_handoffs;
    ALTER TABLE service_handoffs_new RENAME TO service_handoffs;
    CREATE INDEX IF NOT EXISTS idx_service_handoffs_target
      ON service_handoffs(status, target_role, target_agent_type, created_at);
  `);
}
