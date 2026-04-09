import { Database } from 'bun:sqlite';

import {
  ARBITER_AGENT_TYPE,
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  OWNER_AGENT_TYPE,
  SERVICE_SESSION_SCOPE,
  normalizeServiceId,
} from '../config.js';
import {
  inferAgentTypeFromServiceShadow,
  resolveRoleServiceShadow,
} from '../role-service-shadow.js';
import {
  resolveStablePairedTaskOwnerAgentType,
  resolveStableReviewerAgentType,
  resolveStableRoomRoleAgentType,
} from './legacy-rebuilds.js';
import { normalizeStoredAgentType } from './room-registration.js';
import {
  backfillLegacyServiceSessions,
  dropLegacyServiceSessionsTable,
  migrateSessionsTableToCompositePk,
} from './sessions.js';

function getTableColumns(database: Database, tableName: string): string[] {
  return (
    database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

export function tableHasColumn(
  database: Database,
  tableName: string,
  columnName: string,
): boolean {
  return getTableColumns(database, tableName).includes(columnName);
}

function tryExecMigration(database: Database, sql: string): void {
  try {
    database.exec(sql);
  } catch {
    /* column already exists */
  }
}

function backfillMessageSeq(database: Database): void {
  const rows = database
    .prepare(
      `SELECT rowid, seq
       FROM messages
       ORDER BY CASE WHEN seq IS NULL THEN 1 ELSE 0 END, seq, timestamp, rowid`,
    )
    .all() as Array<{ rowid: number; seq: number | null }>;
  if (rows.length === 0) {
    return;
  }

  let nextSeq = 1;
  const assignSeq = database.prepare(
    'UPDATE messages SET seq = ? WHERE rowid = ? AND seq IS NULL',
  );
  const tx = database.transaction(() => {
    for (const row of rows) {
      if (row.seq === null) {
        assignSeq.run(nextSeq, row.rowid);
      }
      nextSeq = Math.max(nextSeq, (row.seq ?? nextSeq) + 1);
    }
  });
  tx();

  const maxSeqRow = database
    .prepare('SELECT MAX(seq) AS maxSeq FROM messages')
    .get() as { maxSeq: number | null };
  const maxSeq = maxSeqRow.maxSeq ?? 0;
  if (maxSeq > 0) {
    database
      .prepare('INSERT OR IGNORE INTO message_sequence (id) VALUES (?)')
      .run(maxSeq);
  }
}

interface LegacyExecutionLeaseServiceRow {
  rowid: number;
  role: string;
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  arbiter_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}

interface StoredPairedTaskServiceRow {
  rowid: number;
  chat_jid: string;
  group_folder: string;
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
}

interface StoredChannelOwnerLeaseServiceRow {
  rowid: number;
  chat_jid: string;
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  arbiter_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}

interface StoredServiceHandoffServiceRow {
  id: number;
  chat_jid: string;
  group_folder: string;
  source_service_id?: string | null;
  target_service_id?: string | null;
  source_role?: string | null;
  target_role?: string | null;
  source_agent_type?: string | null;
  target_agent_type?: string | null;
  intended_role?: string | null;
}

interface StoredWorkItemServiceRow {
  id: number;
  agent_type?: string | null;
  service_id?: string | null;
  delivery_role?: string | null;
}

function normalizePairedRole(
  role: string | null | undefined,
): 'owner' | 'reviewer' | 'arbiter' | null {
  return role === 'owner' || role === 'reviewer' || role === 'arbiter'
    ? role
    : null;
}

function inferLegacyExecutionLeaseServiceId(
  row: LegacyExecutionLeaseServiceRow,
): string | null {
  switch (row.role) {
    case 'owner': {
      const ownerAgentType = normalizeStoredAgentType(row.owner_agent_type);
      return (
        (row.owner_service_id
          ? normalizeServiceId(row.owner_service_id)
          : null) ?? resolveRoleServiceShadow('owner', ownerAgentType)
      );
    }
    case 'reviewer': {
      const reviewerAgentType = normalizeStoredAgentType(
        row.reviewer_agent_type,
      );
      return (
        (row.reviewer_service_id
          ? normalizeServiceId(row.reviewer_service_id)
          : null) ?? resolveRoleServiceShadow('reviewer', reviewerAgentType)
      );
    }
    case 'arbiter': {
      const arbiterAgentType = normalizeStoredAgentType(row.arbiter_agent_type);
      return (
        (row.arbiter_service_id
          ? normalizeServiceId(row.arbiter_service_id)
          : null) ?? resolveRoleServiceShadow('arbiter', arbiterAgentType)
      );
    }
    default:
      return null;
  }
}

function backfillLegacyExecutionLeaseServiceShadows(database: Database): void {
  if (
    !tableHasColumn(
      database,
      'paired_task_execution_leases',
      'claimed_service_id',
    )
  ) {
    return;
  }

  const pairedTasksTable = database
    .prepare(
      `
        SELECT 1
          FROM sqlite_master
         WHERE type = 'table'
           AND name = 'paired_tasks'
      `,
    )
    .get();
  if (!pairedTasksTable) {
    return;
  }

  const pairedTaskColumns = getTableColumns(database, 'paired_tasks');
  const selectPairedTaskColumn = (columnName: string): string =>
    pairedTaskColumns.includes(columnName)
      ? `paired_tasks.${columnName} AS ${columnName}`
      : `NULL AS ${columnName}`;

  const rows = database
    .prepare(
      `
        SELECT
          paired_task_execution_leases.rowid AS rowid,
          paired_task_execution_leases.role AS role,
          ${selectPairedTaskColumn('owner_service_id')},
          ${selectPairedTaskColumn('reviewer_service_id')},
          ${selectPairedTaskColumn('arbiter_service_id')},
          ${selectPairedTaskColumn('owner_agent_type')},
          ${selectPairedTaskColumn('reviewer_agent_type')},
          ${selectPairedTaskColumn('arbiter_agent_type')}
        FROM paired_task_execution_leases
        LEFT JOIN paired_tasks
          ON paired_tasks.id = paired_task_execution_leases.task_id
       WHERE paired_task_execution_leases.claimed_service_id IS NULL
      `,
    )
    .all() as LegacyExecutionLeaseServiceRow[];

  if (rows.length === 0) {
    return;
  }

  const update = database.prepare(
    `
      UPDATE paired_task_execution_leases
         SET claimed_service_id = ?
       WHERE rowid = ?
         AND claimed_service_id IS NULL
    `,
  );
  const tx = database.transaction(
    (leaseRows: LegacyExecutionLeaseServiceRow[]) => {
      for (const row of leaseRows) {
        const claimedServiceId = inferLegacyExecutionLeaseServiceId(row);
        if (!claimedServiceId) {
          continue;
        }
        update.run(claimedServiceId, row.rowid);
      }
    },
  );

  tx(rows);
}

function backfillCanonicalPairedTaskServiceIds(database: Database): void {
  if (
    !tableHasColumn(database, 'paired_tasks', 'owner_service_id') ||
    !tableHasColumn(database, 'paired_tasks', 'reviewer_service_id')
  ) {
    return;
  }

  const rows = database
    .prepare(
      `
        SELECT
          rowid,
          chat_jid,
          group_folder,
          owner_service_id,
          reviewer_service_id,
          owner_agent_type,
          reviewer_agent_type
        FROM paired_tasks
      `,
    )
    .all() as StoredPairedTaskServiceRow[];
  if (rows.length === 0) {
    return;
  }

  const update = database.prepare(
    `
      UPDATE paired_tasks
         SET owner_service_id = ?,
             reviewer_service_id = ?
       WHERE rowid = ?
    `,
  );
  const tx = database.transaction((taskRows: StoredPairedTaskServiceRow[]) => {
    for (const row of taskRows) {
      const persistedOwnerAgentType = normalizeStoredAgentType(
        row.owner_agent_type,
      );
      const persistedReviewerAgentType = normalizeStoredAgentType(
        row.reviewer_agent_type,
      );
      const stableOwnerAgentType = resolveStablePairedTaskOwnerAgentType(
        database,
        row,
      );
      const ownerAgentType =
        stableOwnerAgentType ??
        (row.owner_service_id
          ? inferAgentTypeFromServiceShadow(row.owner_service_id)
          : undefined);
      const stableReviewerAgentType = resolveStableReviewerAgentType(
        stableOwnerAgentType,
        row.reviewer_agent_type ?? null,
      );
      const reviewerAgentType =
        persistedReviewerAgentType ??
        stableReviewerAgentType ??
        (row.reviewer_service_id
          ? inferAgentTypeFromServiceShadow(row.reviewer_service_id)
          : null) ??
        resolveStableReviewerAgentType(ownerAgentType, null);

      const ownerServiceId =
        (persistedOwnerAgentType
          ? resolveRoleServiceShadow('owner', ownerAgentType)
          : null) ??
        row.owner_service_id ??
        resolveRoleServiceShadow('owner', ownerAgentType) ??
        CODEX_MAIN_SERVICE_ID;
      const reviewerServiceId =
        (persistedReviewerAgentType
          ? resolveRoleServiceShadow('reviewer', reviewerAgentType)
          : null) ??
        row.reviewer_service_id ??
        resolveRoleServiceShadow('reviewer', reviewerAgentType) ??
        CODEX_REVIEW_SERVICE_ID;

      if (
        row.owner_service_id === ownerServiceId &&
        row.reviewer_service_id === reviewerServiceId
      ) {
        continue;
      }

      update.run(ownerServiceId, reviewerServiceId, row.rowid);
    }
  });

  tx(rows);
}

function backfillCanonicalChannelOwnerServiceIds(database: Database): void {
  if (!tableHasColumn(database, 'channel_owner', 'owner_service_id')) {
    return;
  }

  const rows = database
    .prepare(
      `
        SELECT
          rowid,
          chat_jid,
          owner_service_id,
          reviewer_service_id,
          arbiter_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type
        FROM channel_owner
      `,
    )
    .all() as StoredChannelOwnerLeaseServiceRow[];
  if (rows.length === 0) {
    return;
  }

  const update = database.prepare(
    `
      UPDATE channel_owner
         SET owner_service_id = ?,
             reviewer_service_id = ?,
             arbiter_service_id = ?
       WHERE rowid = ?
    `,
  );
  const tx = database.transaction(
    (leaseRows: StoredChannelOwnerLeaseServiceRow[]) => {
      for (const row of leaseRows) {
        const persistedOwnerAgentType = normalizeStoredAgentType(
          row.owner_agent_type,
        );
        const persistedReviewerAgentType = normalizeStoredAgentType(
          row.reviewer_agent_type,
        );
        const persistedArbiterAgentType = normalizeStoredAgentType(
          row.arbiter_agent_type,
        );
        const ownerAgentType =
          persistedOwnerAgentType ??
          (row.owner_service_id
            ? inferAgentTypeFromServiceShadow(row.owner_service_id)
            : undefined) ??
          OWNER_AGENT_TYPE;
        const reviewerAgentType =
          row.reviewer_agent_type == null && row.reviewer_service_id == null
            ? null
            : (persistedReviewerAgentType ??
              (row.reviewer_service_id
                ? inferAgentTypeFromServiceShadow(row.reviewer_service_id)
                : null) ??
              resolveStableReviewerAgentType(ownerAgentType, null));
        const arbiterAgentType =
          row.arbiter_agent_type == null && row.arbiter_service_id == null
            ? null
            : (persistedArbiterAgentType ??
              (row.arbiter_service_id
                ? inferAgentTypeFromServiceShadow(row.arbiter_service_id)
                : undefined) ??
              ARBITER_AGENT_TYPE ??
              null);

        const ownerServiceId =
          row.owner_service_id ??
          resolveRoleServiceShadow('owner', ownerAgentType) ??
          CLAUDE_SERVICE_ID;
        const reviewerServiceId =
          row.reviewer_service_id ??
          (reviewerAgentType == null
            ? null
            : resolveRoleServiceShadow('reviewer', reviewerAgentType));
        const arbiterServiceId =
          row.arbiter_service_id ??
          (arbiterAgentType == null
            ? null
            : resolveRoleServiceShadow('arbiter', arbiterAgentType));

        if (
          row.owner_service_id === ownerServiceId &&
          row.reviewer_service_id === reviewerServiceId &&
          row.arbiter_service_id === arbiterServiceId
        ) {
          continue;
        }

        update.run(
          ownerServiceId,
          reviewerServiceId,
          arbiterServiceId,
          row.rowid,
        );
      }
    },
  );

  tx(rows);
}

function backfillCanonicalServiceHandoffServiceIds(database: Database): void {
  if (!tableHasColumn(database, 'service_handoffs', 'source_service_id')) {
    return;
  }

  const rows = database
    .prepare(
      `
        SELECT
          id,
          chat_jid,
          group_folder,
          source_service_id,
          target_service_id,
          source_role,
          target_role,
          source_agent_type,
          target_agent_type,
          intended_role
        FROM service_handoffs
      `,
    )
    .all() as StoredServiceHandoffServiceRow[];
  if (rows.length === 0) {
    return;
  }

  const update = database.prepare(
    `
      UPDATE service_handoffs
         SET source_service_id = ?,
             target_service_id = ?
       WHERE id = ?
    `,
  );
  const tx = database.transaction(
    (handoffRows: StoredServiceHandoffServiceRow[]) => {
      for (const row of handoffRows) {
        const sourceRole =
          normalizePairedRole(row.source_role) ??
          normalizePairedRole(row.intended_role);
        const targetRole =
          normalizePairedRole(row.target_role) ??
          normalizePairedRole(row.intended_role);
        const sourceAgentType =
          normalizeStoredAgentType(row.source_agent_type) ??
          (sourceRole
            ? resolveStableRoomRoleAgentType(database, {
                chatJid: row.chat_jid,
                groupFolder: row.group_folder,
                role: sourceRole,
              })
            : null);
        const targetAgentType =
          normalizeStoredAgentType(row.target_agent_type) ??
          (targetRole
            ? resolveStableRoomRoleAgentType(database, {
                chatJid: row.chat_jid,
                groupFolder: row.group_folder,
                role: targetRole,
              })
            : null) ??
          'claude-code';

        const sourceServiceId =
          row.source_service_id ??
          (sourceRole != null
            ? (resolveRoleServiceShadow(sourceRole, sourceAgentType) ??
              SERVICE_SESSION_SCOPE)
            : SERVICE_SESSION_SCOPE);
        const targetServiceId =
          row.target_service_id ??
          (targetRole != null
            ? (resolveRoleServiceShadow(targetRole, targetAgentType) ??
              SERVICE_SESSION_SCOPE)
            : SERVICE_SESSION_SCOPE);

        if (
          row.source_service_id === sourceServiceId &&
          row.target_service_id === targetServiceId
        ) {
          continue;
        }

        update.run(sourceServiceId, targetServiceId, row.id);
      }
    },
  );

  tx(rows);
}

function backfillCanonicalWorkItemServiceIds(database: Database): void {
  if (!tableHasColumn(database, 'work_items', 'service_id')) {
    return;
  }

  const rows = database
    .prepare(
      `SELECT id, agent_type, service_id, delivery_role
         FROM work_items`,
    )
    .all() as StoredWorkItemServiceRow[];
  if (rows.length === 0) {
    return;
  }

  const update = database.prepare(
    `UPDATE work_items
        SET service_id = ?
      WHERE id = ?`,
  );
  const tx = database.transaction((workItemRows: StoredWorkItemServiceRow[]) => {
    for (const row of workItemRows) {
      const agentType = normalizeStoredAgentType(row.agent_type) ?? 'claude-code';
      const deliveryRole = normalizePairedRole(row.delivery_role) ?? 'owner';
      const serviceId =
        (row.service_id ? normalizeServiceId(row.service_id) : null) ??
        resolveRoleServiceShadow(deliveryRole, agentType) ??
        SERVICE_SESSION_SCOPE;

      if (row.service_id === serviceId) {
        continue;
      }

      update.run(serviceId, row.id);
    }
  });

  tx(rows);
}

export function applySchemaMigrations(
  database: Database,
  args: {
    assistantName: string;
  },
): void {
  const { assistantName } = args;

  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN agent_type TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN ci_provider TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN ci_metadata TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN max_duration_ms INTEGER`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN status_message_id TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN status_started_at TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE scheduled_tasks ADD COLUMN suspended_until TEXT`,
  );

  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN mode_source TEXT NOT NULL DEFAULT 'explicit'`,
  );
  tryExecMigration(database, `ALTER TABLE room_settings ADD COLUMN name TEXT`);
  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN folder TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN trigger_pattern TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN requires_trigger INTEGER DEFAULT 1`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN is_main INTEGER DEFAULT 0`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN owner_agent_type TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE room_settings ADD COLUMN work_dir TEXT`,
  );

  tryExecMigration(
    database,
    `ALTER TABLE service_handoffs ADD COLUMN intended_role TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE service_handoffs ADD COLUMN source_role TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE service_handoffs ADD COLUMN target_role TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE service_handoffs ADD COLUMN source_agent_type TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE service_handoffs ADD COLUMN source_service_id TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE service_handoffs ADD COLUMN target_service_id TEXT`,
  );

  tryExecMigration(
    database,
    `ALTER TABLE paired_tasks ADD COLUMN owner_agent_type TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE paired_tasks ADD COLUMN reviewer_agent_type TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE paired_tasks ADD COLUMN arbiter_agent_type TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE paired_tasks ADD COLUMN owner_service_id TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE paired_tasks ADD COLUMN reviewer_service_id TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE paired_task_execution_leases ADD COLUMN expires_at TEXT`,
  );
  tryExecMigration(
    database,
    `ALTER TABLE paired_task_execution_leases ADD COLUMN claimed_service_id TEXT`,
  );
  database.exec(`
    UPDATE paired_task_execution_leases
       SET expires_at = COALESCE(
         expires_at,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 minutes')
       )
  `);
  // Legacy lease rows predate claimed_service_id. Infer the original service
  // from paired-task role metadata when possible instead of blanket-marking
  // everything as the current service, which would let startup cleanup delete
  // leases that belong to another runtime.
  backfillLegacyExecutionLeaseServiceShadows(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_paired_task_execution_leases_expires_at
      ON paired_task_execution_leases(expires_at)
  `);

  tryExecMigration(
    database,
    `ALTER TABLE work_items ADD COLUMN delivery_role TEXT`,
  );
  tryExecMigration(database, `ALTER TABLE work_items ADD COLUMN service_id TEXT`);

  database.exec(
    `UPDATE service_handoffs
     SET target_role = COALESCE(
       target_role,
       intended_role,
       CASE
         WHEN reason LIKE 'reviewer-%' THEN 'reviewer'
         WHEN reason LIKE 'arbiter-%' THEN 'arbiter'
         WHEN reason IS NOT NULL THEN 'owner'
         ELSE NULL
       END
     )
     WHERE target_role IS NULL`,
  );

  database.exec(
    `UPDATE service_handoffs
     SET source_role = COALESCE(source_role, target_role, intended_role)
     WHERE source_role IS NULL`,
  );

  for (const column of [
    'owner_service_id',
    'reviewer_service_id',
    'arbiter_service_id',
    'owner_agent_type',
    'reviewer_agent_type',
    'arbiter_agent_type',
  ]) {
    tryExecMigration(database, `ALTER TABLE channel_owner ADD COLUMN ${column} TEXT`);
  }

  backfillCanonicalPairedTaskServiceIds(database);
  backfillCanonicalChannelOwnerServiceIds(database);
  backfillCanonicalServiceHandoffServiceIds(database);
  backfillCanonicalWorkItemServiceIds(database);

  database.exec(
    `UPDATE room_settings
     SET mode_source = 'explicit'
     WHERE COALESCE(mode_source, '') NOT IN ('explicit', 'inferred')`,
  );

  database.exec(`
    UPDATE scheduled_tasks
    SET agent_type = COALESCE(
      (
        SELECT CASE WHEN COUNT(*) = 1 THEN MIN(agent_type) ELSE NULL END
        FROM registered_groups
        WHERE jid = scheduled_tasks.chat_jid
          AND folder = scheduled_tasks.group_folder
      ),
      (
        SELECT CASE WHEN COUNT(*) = 1 THEN MIN(agent_type) ELSE NULL END
        FROM registered_groups
        WHERE jid = scheduled_tasks.chat_jid
      ),
      (
        SELECT CASE WHEN COUNT(*) = 1 THEN MIN(agent_type) ELSE NULL END
        FROM registered_groups
        WHERE folder = scheduled_tasks.group_folder
      )
    )
    WHERE agent_type IS NULL;
  `);

  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${assistantName}:%`);
  } catch {
    /* column already exists */
  }

  tryExecMigration(database, `ALTER TABLE messages ADD COLUMN seq INTEGER`);

  backfillMessageSeq(database);

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_jid_seq ON messages(chat_jid, seq);
  `);
  database.exec(`DROP INDEX IF EXISTS idx_work_items_group_agent;`);
  database.exec(`DROP INDEX IF EXISTS idx_work_items_open;`);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_group_agent
      ON work_items(chat_jid, agent_type, service_id, delivery_role, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_open
      ON work_items(chat_jid, agent_type, IFNULL(service_id, ''), IFNULL(delivery_role, ''))
      WHERE status IN ('produced', 'delivery_retry');
  `);

  const registeredGroupsSql = (
    database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'registered_groups'`,
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  if (
    registeredGroupsSql &&
    !registeredGroupsSql.includes('PRIMARY KEY (jid, agent_type)')
  ) {
    const registeredGroupCols = database
      .prepare('PRAGMA table_info(registered_groups)')
      .all() as Array<{ name: string }>;
    const hasIsMain = registeredGroupCols.some((col) => col.name === 'is_main');
    const hasAgentType = registeredGroupCols.some(
      (col) => col.name === 'agent_type',
    );
    const hasWorkDir = registeredGroupCols.some(
      (col) => col.name === 'work_dir',
    );
    const hasAgentConfig = registeredGroupCols.some(
      (col) => col.name === 'agent_config',
    );
    const hasContainerConfig = registeredGroupCols.some(
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
  } else {
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main' AND COALESCE(is_main, 0) = 0`,
    );
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

  const pairedTasksSqlRow = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paired_tasks'`,
    )
    .get() as { sql?: string } | undefined;
  const pairedTasksSql = pairedTasksSqlRow?.sql || '';
  const pairedTasksNeedsRebuild =
    pairedTasksSql &&
    (pairedTasksSql.includes('task_policy') ||
      !pairedTasksSql.includes('round_trip_count'));
  if (pairedTasksNeedsRebuild) {
    database.exec(`DROP TABLE IF EXISTS paired_tasks`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS paired_tasks (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        owner_service_id TEXT NOT NULL,
        reviewer_service_id TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_paired_tasks_chat_status
        ON paired_tasks(chat_jid, status, updated_at);
    `);
  }

  {
    const ptSqlRow = database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paired_tasks'`,
      )
      .get() as { sql?: string } | undefined;
    const ptSql = ptSqlRow?.sql || '';
    if (ptSql && !ptSql.includes('arbiter_requested')) {
      const pairedTaskCols = getTableColumns(database, 'paired_tasks');
      const selectPairedTaskColumn = (columnName: string): string =>
        pairedTaskCols.includes(columnName)
          ? columnName
          : `NULL AS ${columnName}`;
      database.exec(`
        CREATE TABLE paired_tasks_new (
          id TEXT PRIMARY KEY,
          chat_jid TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          owner_service_id TEXT,
          reviewer_service_id TEXT,
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
          id, chat_jid, group_folder, owner_service_id, reviewer_service_id,
          owner_agent_type, reviewer_agent_type,
          arbiter_agent_type, title, source_ref, plan_notes, review_requested_at,
          round_trip_count, status, created_at, updated_at
        )
        SELECT
          id, chat_jid, group_folder,
          ${selectPairedTaskColumn('owner_service_id')},
          ${selectPairedTaskColumn('reviewer_service_id')},
          owner_agent_type, reviewer_agent_type,
          arbiter_agent_type, title, source_ref, plan_notes, review_requested_at,
          round_trip_count, status, created_at, updated_at
        FROM paired_tasks;
        DROP TABLE paired_tasks;
        ALTER TABLE paired_tasks_new RENAME TO paired_tasks;
        CREATE INDEX IF NOT EXISTS idx_paired_tasks_chat_status
          ON paired_tasks(chat_jid, status, updated_at);
      `);
    }
  }

  tryExecMigration(
    database,
    `ALTER TABLE paired_tasks ADD COLUMN completion_reason TEXT`,
  );

  for (const table of [
    'paired_executions',
    'paired_approvals',
    'paired_artifacts',
    'paired_events',
  ]) {
    database.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  const pairedWsSqlRow = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paired_workspaces'`,
    )
    .get() as { sql?: string } | undefined;
  const pairedWsSql = pairedWsSqlRow?.sql || '';
  if (pairedWsSql && pairedWsSql.includes('snapshot_source_fingerprint')) {
    database.exec(`DROP TABLE IF EXISTS paired_workspaces`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS paired_workspaces (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        workspace_dir TEXT NOT NULL,
        snapshot_source_dir TEXT,
        snapshot_ref TEXT,
        status TEXT NOT NULL DEFAULT 'ready',
        snapshot_refreshed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (role IN ('owner', 'reviewer')),
        CHECK (status IN ('ready', 'stale'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_paired_workspaces_task_role
        ON paired_workspaces(task_id, role);
    `);
  }

  const pairedProjSqlRow = database
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paired_projects'`,
    )
    .get() as { sql?: string } | undefined;
  const pairedProjSql = pairedProjSqlRow?.sql || '';
  if (pairedProjSql && pairedProjSql.includes('workspace_topology')) {
    database.exec(`DROP TABLE IF EXISTS paired_projects`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS paired_projects (
        chat_jid TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        canonical_work_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  migrateSessionsTableToCompositePk(database, 'claude-code');
  backfillLegacyServiceSessions(database, inferAgentTypeFromServiceShadow);
  dropLegacyServiceSessionsTable(database);

  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

}
