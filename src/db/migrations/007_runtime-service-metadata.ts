import type { Database } from 'bun:sqlite';

import { SERVICE_SESSION_SCOPE, normalizeServiceId } from '../../config.js';
import { resolveRoleServiceShadow } from '../../role-service-shadow.js';
import {
  fillCanonicalChannelOwnerLeaseMetadata,
  fillCanonicalPairedTaskMetadata,
  fillCanonicalServiceHandoffMetadata,
  inferExecutionLeaseServiceIdFromCanonicalMetadata,
} from '../canonical-role-metadata.js';
import { normalizeStoredAgentType } from '../room-registration.js';
import {
  getTableColumns,
  tableHasColumn,
  tryExecMigration,
} from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

interface StoredPairedTaskServiceRow {
  rowid: number;
  id: string;
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
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

function normalizePairedRole(
  role: string | null | undefined,
): 'owner' | 'reviewer' | 'arbiter' | null {
  return role === 'owner' || role === 'reviewer' || role === 'arbiter'
    ? role
    : null;
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
          id,
          owner_service_id,
          reviewer_service_id,
          owner_agent_type,
          reviewer_agent_type,
          arbiter_agent_type
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
             reviewer_service_id = ?,
             owner_agent_type = ?,
             reviewer_agent_type = ?,
             arbiter_agent_type = ?
       WHERE rowid = ?
    `,
  );
  const tx = database.transaction((taskRows: StoredPairedTaskServiceRow[]) => {
    for (const row of taskRows) {
      const {
        ownerAgentType,
        reviewerAgentType,
        arbiterAgentType,
        ownerServiceId,
        reviewerServiceId,
      } = fillCanonicalPairedTaskMetadata({
        id: row.id,
        owner_service_id: row.owner_service_id,
        reviewer_service_id: row.reviewer_service_id,
        owner_agent_type: row.owner_agent_type,
        reviewer_agent_type: row.reviewer_agent_type,
        arbiter_agent_type: row.arbiter_agent_type,
      });

      if (
        row.owner_service_id === ownerServiceId &&
        row.reviewer_service_id === reviewerServiceId &&
        row.owner_agent_type === ownerAgentType &&
        row.reviewer_agent_type === reviewerAgentType &&
        row.arbiter_agent_type === arbiterAgentType
      ) {
        continue;
      }

      update.run(
        ownerServiceId,
        reviewerServiceId,
        ownerAgentType,
        reviewerAgentType,
        arbiterAgentType,
        row.rowid,
      );
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
             arbiter_service_id = ?,
             owner_agent_type = ?,
             reviewer_agent_type = ?,
             arbiter_agent_type = ?
       WHERE rowid = ?
    `,
  );
  const tx = database.transaction(
    (leaseRows: StoredChannelOwnerLeaseServiceRow[]) => {
      for (const row of leaseRows) {
        const {
          ownerAgentType,
          reviewerAgentType,
          arbiterAgentType,
          ownerServiceId,
          reviewerServiceId,
          arbiterServiceId,
        } = fillCanonicalChannelOwnerLeaseMetadata({
          chat_jid: row.chat_jid,
          owner_service_id: row.owner_service_id,
          reviewer_service_id: row.reviewer_service_id,
          arbiter_service_id: row.arbiter_service_id,
          owner_agent_type: row.owner_agent_type,
          reviewer_agent_type: row.reviewer_agent_type,
          arbiter_agent_type: row.arbiter_agent_type,
        });

        if (
          row.owner_service_id === ownerServiceId &&
          row.reviewer_service_id === reviewerServiceId &&
          row.arbiter_service_id === arbiterServiceId &&
          row.owner_agent_type === ownerAgentType &&
          row.reviewer_agent_type === reviewerAgentType &&
          row.arbiter_agent_type === arbiterAgentType
        ) {
          continue;
        }

        update.run(
          ownerServiceId,
          reviewerServiceId,
          arbiterServiceId,
          ownerAgentType,
          reviewerAgentType,
          arbiterAgentType,
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
             target_service_id = ?,
             source_agent_type = ?,
             target_agent_type = ?,
             source_role = ?,
             target_role = ?
       WHERE id = ?
    `,
  );
  const tx = database.transaction(
    (handoffRows: StoredServiceHandoffServiceRow[]) => {
      for (const row of handoffRows) {
        const {
          sourceRole,
          targetRole,
          sourceAgentType,
          targetAgentType,
          sourceServiceId,
          targetServiceId,
        } = fillCanonicalServiceHandoffMetadata({
          id: row.id,
          chat_jid: row.chat_jid,
          source_service_id: row.source_service_id,
          target_service_id: row.target_service_id,
          source_role: row.source_role,
          target_role: row.target_role,
          intended_role: row.intended_role,
          source_agent_type: row.source_agent_type,
          target_agent_type: row.target_agent_type,
        });

        if (
          row.source_service_id === sourceServiceId &&
          row.target_service_id === targetServiceId &&
          row.source_agent_type === (sourceAgentType ?? null) &&
          row.target_agent_type === targetAgentType &&
          row.source_role === sourceRole &&
          row.target_role === targetRole
        ) {
          continue;
        }

        update.run(
          sourceServiceId,
          targetServiceId,
          sourceAgentType,
          targetAgentType,
          sourceRole,
          targetRole,
          row.id,
        );
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
  const tx = database.transaction(
    (workItemRows: StoredWorkItemServiceRow[]) => {
      for (const row of workItemRows) {
        const agentType =
          normalizeStoredAgentType(row.agent_type) ?? 'claude-code';
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
    },
  );

  tx(rows);
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
        const claimedServiceId =
          inferExecutionLeaseServiceIdFromCanonicalMetadata(row);
        if (!claimedServiceId) {
          continue;
        }

        update.run(claimedServiceId, row.rowid);
      }
    },
  );

  tx(rows);
}

export const RUNTIME_SERVICE_METADATA_MIGRATION = {
  version: 7,
  name: 'runtime_service_metadata',
  apply(database) {
    for (const statement of [
      `ALTER TABLE service_handoffs ADD COLUMN intended_role TEXT`,
      `ALTER TABLE service_handoffs ADD COLUMN source_role TEXT`,
      `ALTER TABLE service_handoffs ADD COLUMN target_role TEXT`,
      `ALTER TABLE service_handoffs ADD COLUMN source_agent_type TEXT`,
      `ALTER TABLE service_handoffs ADD COLUMN source_service_id TEXT`,
      `ALTER TABLE service_handoffs ADD COLUMN target_service_id TEXT`,
      `ALTER TABLE paired_tasks ADD COLUMN owner_service_id TEXT`,
      `ALTER TABLE paired_tasks ADD COLUMN reviewer_service_id TEXT`,
      `ALTER TABLE paired_tasks ADD COLUMN owner_agent_type TEXT`,
      `ALTER TABLE paired_tasks ADD COLUMN reviewer_agent_type TEXT`,
      `ALTER TABLE paired_tasks ADD COLUMN arbiter_agent_type TEXT`,
      `ALTER TABLE paired_task_execution_leases ADD COLUMN expires_at TEXT`,
      `ALTER TABLE paired_task_execution_leases ADD COLUMN claimed_service_id TEXT`,
      `ALTER TABLE work_items ADD COLUMN delivery_role TEXT`,
      `ALTER TABLE work_items ADD COLUMN service_id TEXT`,
    ]) {
      tryExecMigration(database, statement);
    }

    for (const column of [
      'owner_service_id',
      'reviewer_service_id',
      'arbiter_service_id',
      'owner_agent_type',
      'reviewer_agent_type',
      'arbiter_agent_type',
    ]) {
      tryExecMigration(
        database,
        `ALTER TABLE channel_owner ADD COLUMN ${column} TEXT`,
      );
    }

    database.exec(`
      UPDATE paired_task_execution_leases
         SET expires_at = COALESCE(
           expires_at,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 minutes')
         )
    `);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_paired_task_execution_leases_expires_at
        ON paired_task_execution_leases(expires_at)
    `);

    backfillCanonicalPairedTaskServiceIds(database);
    backfillCanonicalChannelOwnerServiceIds(database);
    backfillCanonicalServiceHandoffServiceIds(database);
    backfillCanonicalWorkItemServiceIds(database);
    backfillLegacyExecutionLeaseServiceShadows(database);
  },
} satisfies SchemaMigrationDefinition;
