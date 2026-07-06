import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, _initTestDatabaseFromFile } from './db.js';
import { initializeDatabaseSchema } from './db/bootstrap.js';
import {
  buildPairedTurnAttemptId,
  buildPairedTurnAttemptParentId,
} from './db/paired-turn-attempts.js';
import { CLAUDE_SERVICE_ID, CODEX_REVIEW_SERVICE_ID } from './config.js';
import { insertPairedTurnIdentityRow } from '../test/helpers/db-test-utils.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('legacy turn attempt provenance backfill', () => {
  it('backfills turn attempt provenance onto legacy reservations, leases, and handoffs during init', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-turn-attempt-provenance-'),
    );
    const dbPath = path.join(tempDir, 'turn-attempt-provenance.db');

    try {
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE paired_turns (
          turn_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          executor_service_id TEXT,
          executor_agent_type TEXT,
          attempt_no INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT
        );
        CREATE TABLE paired_turn_attempts (
          turn_id TEXT NOT NULL,
          attempt_no INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          executor_service_id TEXT,
          executor_agent_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT,
          PRIMARY KEY (turn_id, attempt_no)
        );
        CREATE TABLE paired_turn_reservations (
          chat_jid TEXT NOT NULL,
          task_id TEXT NOT NULL,
          task_status TEXT NOT NULL,
          round_trip_count INTEGER NOT NULL DEFAULT 0,
          task_updated_at TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          turn_role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          scheduled_run_id TEXT,
          consumed_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          consumed_at TEXT,
          PRIMARY KEY (chat_jid, task_id, task_updated_at, intent_kind)
        );
        CREATE TABLE paired_task_execution_leases (
          task_id TEXT PRIMARY KEY,
          chat_jid TEXT NOT NULL,
          role TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          claimed_run_id TEXT NOT NULL,
          claimed_service_id TEXT NOT NULL,
          task_status TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE service_handoffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_jid TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          source_service_id TEXT NOT NULL,
          target_service_id TEXT NOT NULL,
          paired_task_id TEXT,
          paired_task_updated_at TEXT,
          turn_id TEXT,
          turn_intent_kind TEXT,
          turn_role TEXT,
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
          last_error TEXT
        );
      `);
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turns (
              turn_id,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              attempt_no,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn',
          'legacy-provenance-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'running',
          'other-service',
          'codex',
          2,
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T01:00:00.000Z',
          null,
          null,
        );
      const insertAttempt = legacyDb.prepare(
        `
          INSERT INTO paired_turn_attempts (
            turn_id,
            attempt_no,
            task_id,
            task_updated_at,
            role,
            intent_kind,
            state,
            executor_service_id,
            executor_agent_type,
            created_at,
            updated_at,
            completed_at,
            last_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      insertAttempt.run(
        'legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn',
        1,
        'legacy-provenance-task',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'delegated',
        'other-service',
        'codex',
        '2026-04-10T00:00:00.000Z',
        '2026-04-10T00:30:00.000Z',
        '2026-04-10T00:30:00.000Z',
        'legacy attempt 1 delegated',
      );
      insertAttempt.run(
        'legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn',
        2,
        'legacy-provenance-task',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'running',
        'other-service',
        'codex',
        '2026-04-10T00:40:00.000Z',
        '2026-04-10T01:00:00.000Z',
        null,
        null,
      );
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turn_reservations (
              chat_jid,
              task_id,
              task_status,
              round_trip_count,
              task_updated_at,
              turn_id,
              turn_role,
              intent_kind,
              status,
              scheduled_run_id,
              consumed_run_id,
              created_at,
              updated_at,
              consumed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'legacy-provenance-task',
          'review_ready',
          1,
          '2026-04-10T00:00:00.000Z',
          'legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn',
          'reviewer',
          'reviewer-turn',
          'completed',
          'run-scheduled',
          'run-consumed',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T01:00:00.000Z',
          '2026-04-10T01:00:00.000Z',
        );
      legacyDb
        .prepare(
          `
            INSERT INTO paired_task_execution_leases (
              task_id,
              chat_jid,
              role,
              turn_id,
              intent_kind,
              claimed_run_id,
              claimed_service_id,
              task_status,
              task_updated_at,
              claimed_at,
              updated_at,
              expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'legacy-provenance-task',
          'group@test',
          'reviewer',
          'legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn',
          'reviewer-turn',
          'run-active',
          'other-service',
          'review_ready',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T01:00:00.000Z',
          '2099-04-10T01:10:00.000Z',
        );
      legacyDb
        .prepare(
          `
            INSERT INTO service_handoffs (
              chat_jid,
              group_folder,
              source_service_id,
              target_service_id,
              paired_task_id,
              paired_task_updated_at,
              turn_id,
              turn_intent_kind,
              turn_role,
              source_role,
              source_agent_type,
              target_role,
              target_agent_type,
              prompt,
              status,
              intended_role,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'legacy-provenance-task',
          '2026-04-10T00:00:00.000Z',
          'legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn',
          'reviewer-turn',
          'reviewer',
          'owner',
          'claude-code',
          'reviewer',
          'codex',
          'legacy provenance handoff',
          'pending',
          'reviewer',
          '2026-04-10T00:50:00.000Z',
        );
      legacyDb.close();

      _initTestDatabaseFromFile(dbPath);

      const rawDb = new Database(dbPath, { readonly: true });
      expect(
        rawDb
          .prepare(
            `SELECT turn_attempt_no
               FROM paired_turn_reservations
              WHERE turn_id = ?`,
          )
          .get('legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn'),
      ).toEqual({ turn_attempt_no: 2 });
      expect(
        rawDb
          .prepare(
            `SELECT turn_attempt_no
               FROM paired_task_execution_leases
              WHERE turn_id = ?`,
          )
          .get('legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn'),
      ).toEqual({ turn_attempt_no: 2 });
      expect(
        rawDb
          .prepare(
            `SELECT turn_attempt_no
               FROM service_handoffs
              WHERE turn_id = ?`,
          )
          .get('legacy-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn'),
      ).toEqual({ turn_attempt_no: 2 });
      rawDb.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});

describe('legacy multi-attempt provenance backfill', () => {
  it('preserves per-row attempt provenance when backfilling a multi-attempt legacy turn', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-turn-attempt-provenance-multi-'),
    );
    const dbPath = path.join(tempDir, 'turn-attempt-provenance-multi.db');
    const turnId =
      'legacy-multi-provenance:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      const legacyDb = new Database(dbPath);
      initializeDatabaseSchema(legacyDb);

      insertPairedTurnIdentityRow(legacyDb, {
        turnId,
        taskId: 'legacy-multi-provenance',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:01:00.000Z',
        updatedAt: '2026-04-10T00:02:40.000Z',
      });

      const insertAttempt = legacyDb.prepare(
        `
          INSERT INTO paired_turn_attempts (
            attempt_id,
            parent_attempt_id,
            turn_id,
            attempt_no,
            task_id,
            task_updated_at,
            role,
            intent_kind,
            state,
            executor_service_id,
            executor_agent_type,
            created_at,
            updated_at,
            completed_at,
            last_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 1),
        null,
        turnId,
        1,
        'legacy-multi-provenance',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'delegated',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:01:00.000Z',
        '2026-04-10T00:01:50.000Z',
        '2026-04-10T00:01:50.000Z',
        'attempt 1 delegated',
      );
      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 2),
        buildPairedTurnAttemptParentId(turnId, 2),
        turnId,
        2,
        'legacy-multi-provenance',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'failed',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:02:00.000Z',
        '2026-04-10T00:02:40.000Z',
        '2026-04-10T00:02:40.000Z',
        'attempt 2 failed',
      );

      legacyDb
        .prepare(
          `
            INSERT INTO paired_turn_reservations (
              chat_jid,
              task_id,
              task_status,
              round_trip_count,
              task_updated_at,
              turn_id,
              turn_attempt_no,
              turn_role,
              intent_kind,
              status,
              scheduled_run_id,
              consumed_run_id,
              created_at,
              updated_at,
              consumed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'legacy-multi-provenance',
          'review_ready',
          1,
          '2026-04-10T00:00:00.000Z',
          turnId,
          'reviewer',
          'reviewer-turn',
          'completed',
          'run-scheduled-1',
          'run-consumed-1',
          '2026-04-10T00:00:30.000Z',
          '2026-04-10T00:01:10.000Z',
          '2026-04-10T00:01:10.000Z',
        );

      legacyDb
        .prepare(
          `
            INSERT INTO paired_task_execution_leases (
              task_id,
              chat_jid,
              role,
              turn_id,
              turn_attempt_no,
              intent_kind,
              claimed_run_id,
              claimed_service_id,
              task_status,
              task_updated_at,
              claimed_at,
              updated_at,
              expires_at
            )
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'legacy-multi-provenance',
          'group@test',
          'reviewer',
          turnId,
          'reviewer-turn',
          'run-active-1',
          CODEX_REVIEW_SERVICE_ID,
          'review_ready',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:01:15.000Z',
          '2026-04-10T00:01:20.000Z',
          '2099-04-10T00:11:20.000Z',
        );

      const insertHandoff = legacyDb.prepare(
        `
          INSERT INTO service_handoffs (
            chat_jid,
            group_folder,
            paired_task_id,
            paired_task_updated_at,
            turn_id,
            turn_attempt_no,
            turn_intent_kind,
            turn_role,
            source_service_id,
            target_service_id,
            source_role,
            source_agent_type,
            target_role,
            target_agent_type,
            prompt,
            status,
            intended_role,
            created_at,
            claimed_at,
            completed_at,
            last_error
          )
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      insertHandoff.run(
        'group@test',
        'test-group',
        'legacy-multi-provenance',
        '2026-04-10T00:00:00.000Z',
        turnId,
        'reviewer-turn',
        'reviewer',
        CLAUDE_SERVICE_ID,
        CODEX_REVIEW_SERVICE_ID,
        'owner',
        'claude-code',
        'reviewer',
        'codex',
        'legacy handoff attempt 1',
        'failed',
        'reviewer',
        '2026-04-10T00:01:30.000Z',
        '2026-04-10T00:01:35.000Z',
        '2026-04-10T00:01:50.000Z',
        'attempt 1 failed',
      );
      insertHandoff.run(
        'group@test',
        'test-group',
        'legacy-multi-provenance',
        '2026-04-10T00:00:00.000Z',
        turnId,
        'reviewer-turn',
        'reviewer',
        CLAUDE_SERVICE_ID,
        CODEX_REVIEW_SERVICE_ID,
        'owner',
        'claude-code',
        'reviewer',
        'codex',
        'legacy handoff attempt 2',
        'pending',
        'reviewer',
        '2026-04-10T00:02:10.000Z',
        null,
        null,
        null,
      );
      legacyDb.close();

      _initTestDatabaseFromFile(dbPath);

      const rawDb = new Database(dbPath, { readonly: true });
      expect(
        rawDb
          .prepare(
            `
              SELECT turn_attempt_no
                FROM paired_turn_reservations
               WHERE turn_id = ?
            `,
          )
          .get(turnId),
      ).toEqual({ turn_attempt_no: 1 });
      expect(
        rawDb
          .prepare(
            `
              SELECT turn_attempt_no
                FROM paired_task_execution_leases
               WHERE turn_id = ?
            `,
          )
          .get(turnId),
      ).toEqual({ turn_attempt_no: 1 });
      expect(
        rawDb
          .prepare(
            `
              SELECT id, turn_attempt_no
                FROM service_handoffs
               WHERE turn_id = ?
               ORDER BY id ASC
            `,
          )
          .all(turnId),
      ).toEqual([
        { id: 1, turn_attempt_no: 1 },
        { id: 2, turn_attempt_no: 2 },
      ]);
      expect(
        rawDb
          .prepare(
            `
              SELECT attempt_no, parent_attempt_id
                FROM paired_turn_attempts
               WHERE turn_id = ?
               ORDER BY attempt_no ASC
            `,
          )
          .all(turnId),
      ).toEqual([
        { attempt_no: 1, parent_attempt_id: null },
        {
          attempt_no: 2,
          parent_attempt_id: buildPairedTurnAttemptParentId(turnId, 2),
        },
      ]);
      rawDb.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});

describe('legacy provenance foreign key rebuild', () => {
  it('rebuilds legacy turn-attempt provenance tables with actual foreign keys on init', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-turn-attempt-fk-rebuild-'),
    );
    const dbPath = path.join(tempDir, 'turn-attempt-fk-rebuild.db');

    try {
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE paired_turns (
          turn_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'queued',
          executor_service_id TEXT,
          executor_agent_type TEXT,
          active_run_id TEXT,
          attempt_no INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT
        );
        CREATE TABLE paired_turn_attempts (
          turn_id TEXT NOT NULL,
          attempt_no INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          executor_service_id TEXT,
          executor_agent_type TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT,
          PRIMARY KEY (turn_id, attempt_no)
        );
        CREATE TABLE paired_turn_reservations (
          chat_jid TEXT NOT NULL,
          task_id TEXT NOT NULL,
          task_status TEXT NOT NULL,
          round_trip_count INTEGER NOT NULL DEFAULT 0,
          task_updated_at TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          turn_attempt_no INTEGER,
          turn_role TEXT NOT NULL,
          intent_kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          scheduled_run_id TEXT,
          consumed_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          consumed_at TEXT,
          PRIMARY KEY (chat_jid, task_id, task_updated_at, intent_kind)
        );
        CREATE TABLE paired_task_execution_leases (
          task_id TEXT PRIMARY KEY,
          chat_jid TEXT NOT NULL,
          role TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          turn_attempt_no INTEGER,
          intent_kind TEXT NOT NULL,
          claimed_run_id TEXT NOT NULL,
          claimed_service_id TEXT NOT NULL,
          task_status TEXT NOT NULL,
          task_updated_at TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE service_handoffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_jid TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          source_service_id TEXT NOT NULL,
          target_service_id TEXT NOT NULL,
          paired_task_id TEXT,
          paired_task_updated_at TEXT,
          turn_id TEXT,
          turn_attempt_no INTEGER,
          turn_intent_kind TEXT,
          turn_role TEXT,
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
          last_error TEXT
        );
      `);
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turns (
              turn_id,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              attempt_no,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'fk-rebuild-turn:2026-04-10T00:00:00.000Z:reviewer-turn',
          'fk-rebuild-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          1,
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:01:00.000Z',
          '2026-04-10T00:01:00.000Z',
          'attempt failed',
        );
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turn_attempts (
              turn_id,
              attempt_no,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'fk-rebuild-turn:2026-04-10T00:00:00.000Z:reviewer-turn',
          1,
          'fk-rebuild-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:01:00.000Z',
          '2026-04-10T00:01:00.000Z',
          'attempt failed',
        );
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turn_reservations (
              chat_jid,
              task_id,
              task_status,
              round_trip_count,
              task_updated_at,
              turn_id,
              turn_attempt_no,
              turn_role,
              intent_kind,
              status,
              scheduled_run_id,
              consumed_run_id,
              created_at,
              updated_at,
              consumed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'fk-rebuild-task',
          'review_ready',
          1,
          '2026-04-10T00:00:00.000Z',
          'fk-rebuild-turn:2026-04-10T00:00:00.000Z:reviewer-turn',
          1,
          'reviewer',
          'reviewer-turn',
          'completed',
          'run-1',
          'run-1',
          '2026-04-10T00:00:10.000Z',
          '2026-04-10T00:00:20.000Z',
          '2026-04-10T00:00:20.000Z',
        );
      legacyDb.close();

      _initTestDatabaseFromFile(dbPath);

      const migratedDb = new Database(dbPath, { readonly: true });
      const attemptFks = migratedDb
        .prepare(`PRAGMA foreign_key_list(paired_turn_attempts)`)
        .all() as Array<{ table: string; from: string; to: string }>;
      const reservationFks = migratedDb
        .prepare(`PRAGMA foreign_key_list(paired_turn_reservations)`)
        .all() as Array<{ table: string; from: string; to: string }>;
      const leaseFks = migratedDb
        .prepare(`PRAGMA foreign_key_list(paired_task_execution_leases)`)
        .all() as Array<{ table: string; from: string; to: string }>;
      const handoffFks = migratedDb
        .prepare(`PRAGMA foreign_key_list(service_handoffs)`)
        .all() as Array<{ table: string; from: string; to: string }>;

      expect(
        attemptFks.some(
          (row) =>
            row.table === 'paired_turns' &&
            row.from === 'turn_id' &&
            row.to === 'turn_id',
        ),
      ).toBe(true);
      expect(
        attemptFks.some(
          (row) =>
            row.table === 'paired_turn_attempts' &&
            row.from === 'parent_attempt_id' &&
            row.to === 'attempt_id',
        ),
      ).toBe(true);
      expect(
        attemptFks.some(
          (row) =>
            row.table === 'service_handoffs' &&
            row.from === 'parent_handoff_id' &&
            row.to === 'id',
        ),
      ).toBe(true);
      expect(
        attemptFks.some(
          (row) =>
            row.table === 'service_handoffs' &&
            row.from === 'continuation_handoff_id' &&
            row.to === 'id',
        ),
      ).toBe(true);
      expect(
        reservationFks.some(
          (row) =>
            row.table === 'paired_turn_attempts' && row.from === 'turn_id',
        ),
      ).toBe(true);
      expect(
        leaseFks.some(
          (row) =>
            row.table === 'paired_turn_attempts' && row.from === 'turn_id',
        ),
      ).toBe(true);
      expect(
        handoffFks.some(
          (row) =>
            row.table === 'paired_turn_attempts' && row.from === 'turn_id',
        ),
      ).toBe(true);
      migratedDb.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});
