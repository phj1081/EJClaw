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

describe('turn attempt provenance write triggers', () => {
  it('rejects mismatched turn-attempt provenance writes across attempt-backed tables', () => {
    const database = new Database(':memory:');
    const turnId =
      'trigger-provenance-task:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      initializeDatabaseSchema(database);

      insertPairedTurnIdentityRow(database, {
        turnId,
        taskId: 'trigger-provenance-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:00.000Z',
      });

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_turn_attempts (
                attempt_id,
                turn_id,
                attempt_no,
                task_id,
                task_updated_at,
                role,
                intent_kind,
                state,
                executor_service_id,
                executor_agent_type,
                active_run_id,
                created_at,
                updated_at,
                completed_at,
                last_error
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            buildPairedTurnAttemptId(turnId, 1),
            turnId,
            1,
            'trigger-provenance-task',
            '2026-04-10T00:00:00.000Z',
            'owner',
            'reviewer-turn',
            'running',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            'run-trigger-provenance-1',
            '2026-04-10T00:00:00.000Z',
            '2026-04-10T00:00:00.000Z',
            null,
            null,
          ),
      ).toThrow(
        /paired_turn_attempts must reference a matching paired_turns row/,
      );

      database
        .prepare(
          `
            INSERT INTO paired_turn_attempts (
              attempt_id,
              turn_id,
              attempt_no,
              task_id,
              task_updated_at,
              role,
              intent_kind,
              state,
              executor_service_id,
              executor_agent_type,
              active_run_id,
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(turnId, 1),
          turnId,
          1,
          'trigger-provenance-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'running',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          'run-trigger-provenance-2',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:00:00.000Z',
          null,
          null,
        );

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_turn_reservations (
                chat_jid,
                task_id,
                task_status,
                round_trip_count,
                task_updated_at,
                turn_id,
                turn_attempt_id,
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
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            'group@test',
            'trigger-provenance-task',
            'review_ready',
            1,
            '2026-04-10T00:00:00.000Z',
            turnId,
            'bad-attempt-id',
            1,
            'owner',
            'reviewer-turn',
            'completed',
            'run-scheduled-1',
            'run-consumed-1',
            '2026-04-10T00:00:10.000Z',
            '2026-04-10T00:00:20.000Z',
            '2026-04-10T00:00:20.000Z',
          ),
      ).toThrow(
        /paired_turn_reservations turn_attempt_no must reference a matching paired_turn_attempts row/,
      );

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_task_execution_leases (
                task_id,
                chat_jid,
                role,
                turn_id,
                turn_attempt_id,
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
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            'trigger-provenance-task',
            'group@test',
            'reviewer',
            turnId,
            'bad-attempt-id',
            1,
            'reviewer-turn',
            'run-1',
            CODEX_REVIEW_SERVICE_ID,
            'review_ready',
            '2026-04-10T00:05:00.000Z',
            '2026-04-10T00:00:15.000Z',
            '2026-04-10T00:00:16.000Z',
            '2099-04-10T00:10:16.000Z',
          ),
      ).toThrow(
        /paired_task_execution_leases turn_attempt_no must reference a matching paired_turn_attempts row/,
      );

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO service_handoffs (
                chat_jid,
                group_folder,
                paired_task_id,
                paired_task_updated_at,
                turn_id,
                turn_attempt_id,
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
                created_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            'group@test',
            'test-group',
            'trigger-provenance-task',
            '2026-04-10T00:05:00.000Z',
            turnId,
            'bad-attempt-id',
            1,
            'reviewer-turn',
            'reviewer',
            CLAUDE_SERVICE_ID,
            CODEX_REVIEW_SERVICE_ID,
            'owner',
            'claude-code',
            'reviewer',
            'codex',
            'trigger provenance handoff',
            'pending',
            'reviewer',
            '2026-04-10T00:00:25.000Z',
          ),
      ).toThrow(
        /service_handoffs turn_attempt_no must reference a matching paired_turn_attempts row/,
      );
    } finally {
      database.close();
    }
  });
});

describe('turn attempt provenance turn references', () => {
  it('fails init when a legacy handoff keeps an invalid turn_attempt_no provenance reference', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-invalid-handoff-turn-attempt-'),
    );
    const dbPath = path.join(tempDir, 'invalid-handoff-turn-attempt.db');
    const turnId =
      'legacy-invalid-handoff:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      const legacyDb = new Database(dbPath);
      initializeDatabaseSchema(legacyDb);
      legacyDb.exec(`
        DROP TRIGGER IF EXISTS service_handoffs_validate_attempt_insert;
        DROP TRIGGER IF EXISTS service_handoffs_validate_attempt_update;
      `);

      insertPairedTurnIdentityRow(legacyDb, {
        turnId,
        taskId: 'legacy-invalid-handoff',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
      legacyDb
        .prepare(
          `
            INSERT INTO paired_turn_attempts (
              attempt_id,
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(turnId, 1),
          turnId,
          1,
          'legacy-invalid-handoff',
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
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          'legacy-invalid-handoff',
          '2026-04-10T00:05:00.000Z',
          turnId,
          1,
          'reviewer-turn',
          'reviewer',
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'owner',
          'claude-code',
          'reviewer',
          'codex',
          'legacy invalid handoff',
          'failed',
          'reviewer',
          '2026-04-10T00:00:30.000Z',
        );
      legacyDb.close();

      expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
        /service_handoffs\(id=1\) has invalid paired_turn_attempt provenance/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});

describe('turn attempt provenance parent handoff references', () => {
  it('fails init when an attempt keeps an invalid parent_handoff_id provenance reference', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-invalid-parent-handoff-'),
    );
    const dbPath = path.join(tempDir, 'invalid-parent-handoff.db');
    const turnId =
      'legacy-invalid-parent-handoff:2026-04-10T00:00:00.000Z:reviewer-turn';
    const otherTurnId =
      'legacy-other-parent-handoff:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      const legacyDb = new Database(dbPath);
      initializeDatabaseSchema(legacyDb);
      legacyDb.exec(`
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
      `);

      const insertTurn = (args: {
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
      }) => insertPairedTurnIdentityRow(legacyDb, args);
      const insertAttempt = legacyDb.prepare(
        `
          INSERT INTO paired_turn_attempts (
            attempt_id,
            parent_attempt_id,
            parent_handoff_id,
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );

      insertTurn({
        turnId: otherTurnId,
        taskId: 'legacy-other-parent-handoff',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:30.000Z',
      });
      insertAttempt.run(
        buildPairedTurnAttemptId(otherTurnId, 1),
        null,
        null,
        otherTurnId,
        1,
        'legacy-other-parent-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'delegated',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:00:00.000Z',
        '2026-04-10T00:00:30.000Z',
        null,
        null,
      );
      legacyDb
        .prepare(
          `
            INSERT INTO service_handoffs (
              chat_jid,
              group_folder,
              paired_task_id,
              paired_task_updated_at,
              turn_id,
              turn_attempt_id,
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
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          'legacy-other-parent-handoff',
          '2026-04-10T00:00:00.000Z',
          otherTurnId,
          buildPairedTurnAttemptId(otherTurnId, 1),
          1,
          'reviewer-turn',
          'reviewer',
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'owner',
          'claude-code',
          'reviewer',
          'codex',
          'wrong parent handoff',
          'failed',
          'reviewer',
          '2026-04-10T00:00:20.000Z',
        );
      const wrongHandoffId = (
        legacyDb.prepare('SELECT last_insert_rowid() AS id').get() as {
          id: number;
        }
      ).id;

      insertTurn({
        turnId,
        taskId: 'legacy-invalid-parent-handoff',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 1),
        null,
        null,
        turnId,
        1,
        'legacy-invalid-parent-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'failed',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:00:00.000Z',
        '2026-04-10T00:00:40.000Z',
        '2026-04-10T00:00:40.000Z',
        'attempt 1 failed',
      );
      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 2),
        buildPairedTurnAttemptParentId(turnId, 2),
        wrongHandoffId,
        turnId,
        2,
        'legacy-invalid-parent-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'running',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:01:00.000Z',
        '2026-04-10T00:01:00.000Z',
        null,
        null,
      );
      legacyDb.close();

      expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
        /invalid parent_handoff_id provenance/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});

describe('turn attempt provenance completed parent handoffs', () => {
  it('fails init when an attempt keeps a completed parent_handoff_id provenance reference', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-completed-parent-handoff-'),
    );
    const dbPath = path.join(tempDir, 'completed-parent-handoff.db');
    const turnId =
      'legacy-completed-parent-handoff:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      const legacyDb = new Database(dbPath);
      initializeDatabaseSchema(legacyDb);
      legacyDb.exec(`
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
      `);

      const insertTurn = (args: {
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
      }) => insertPairedTurnIdentityRow(legacyDb, args);
      const insertAttempt = legacyDb.prepare(
        `
          INSERT INTO paired_turn_attempts (
            attempt_id,
            parent_attempt_id,
            parent_handoff_id,
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );

      insertTurn({
        turnId,
        taskId: 'legacy-completed-parent-handoff',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 1),
        null,
        null,
        turnId,
        1,
        'legacy-completed-parent-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'completed',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:00:00.000Z',
        '2026-04-10T00:00:40.000Z',
        '2026-04-10T00:00:40.000Z',
        null,
      );
      legacyDb
        .prepare(
          `
            INSERT INTO service_handoffs (
              chat_jid,
              group_folder,
              paired_task_id,
              paired_task_updated_at,
              turn_id,
              turn_attempt_id,
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
              completed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          'legacy-completed-parent-handoff',
          '2026-04-10T00:00:00.000Z',
          turnId,
          buildPairedTurnAttemptId(turnId, 1),
          1,
          'reviewer-turn',
          'reviewer',
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'owner',
          'claude-code',
          'reviewer',
          'codex',
          'completed handoff cannot seed retry lineage',
          'completed',
          'reviewer',
          '2026-04-10T00:00:20.000Z',
          '2026-04-10T00:00:30.000Z',
        );
      const completedHandoffId = (
        legacyDb.prepare('SELECT last_insert_rowid() AS id').get() as {
          id: number;
        }
      ).id;

      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 2),
        buildPairedTurnAttemptParentId(turnId, 2),
        completedHandoffId,
        turnId,
        2,
        'legacy-completed-parent-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'running',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:01:00.000Z',
        '2026-04-10T00:01:00.000Z',
        null,
        null,
      );
      legacyDb.close();

      expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
        /invalid parent_handoff_id provenance/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});

describe('turn attempt provenance continuation handoffs', () => {
  it('fails init when an attempt keeps an invalid continuation_handoff_id provenance reference', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-invalid-continuation-handoff-'),
    );
    const dbPath = path.join(tempDir, 'invalid-continuation-handoff.db');
    const turnId =
      'legacy-invalid-continuation-handoff:2026-04-10T00:00:00.000Z:reviewer-turn';
    const otherTurnId =
      'legacy-other-continuation-handoff:2026-04-10T00:00:00.000Z:reviewer-turn';

    try {
      const legacyDb = new Database(dbPath);
      initializeDatabaseSchema(legacyDb);
      legacyDb.exec(`
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
      `);

      const insertTurn = (args: {
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
      }) =>
        insertPairedTurnIdentityRow(legacyDb, {
          turnId: args.turnId,
          taskId: args.taskId,
          taskUpdatedAt: args.taskUpdatedAt,
          role: args.role,
          intentKind: args.intentKind,
          createdAt: args.createdAt,
          updatedAt: args.updatedAt,
        });
      const insertAttempt = legacyDb.prepare(
        `
          INSERT INTO paired_turn_attempts (
            attempt_id,
            parent_attempt_id,
            parent_handoff_id,
            continuation_handoff_id,
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );

      insertTurn({
        turnId: otherTurnId,
        taskId: 'legacy-other-continuation-handoff',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:30.000Z',
      });
      insertAttempt.run(
        buildPairedTurnAttemptId(otherTurnId, 1),
        null,
        null,
        null,
        otherTurnId,
        1,
        'legacy-other-continuation-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'delegated',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:00:00.000Z',
        '2026-04-10T00:00:30.000Z',
        null,
        null,
      );
      legacyDb
        .prepare(
          `
            INSERT INTO service_handoffs (
              chat_jid,
              group_folder,
              paired_task_id,
              paired_task_updated_at,
              turn_id,
              turn_attempt_id,
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
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          'legacy-other-continuation-handoff',
          '2026-04-10T00:00:00.000Z',
          otherTurnId,
          buildPairedTurnAttemptId(otherTurnId, 1),
          1,
          'reviewer-turn',
          'reviewer',
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'owner',
          'claude-code',
          'reviewer',
          'codex',
          'wrong continuation handoff',
          'claimed',
          'reviewer',
          '2026-04-10T00:00:20.000Z',
        );
      const wrongHandoffId = (
        legacyDb.prepare('SELECT last_insert_rowid() AS id').get() as {
          id: number;
        }
      ).id;

      insertTurn({
        turnId,
        taskId: 'legacy-invalid-continuation-handoff',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
      insertAttempt.run(
        buildPairedTurnAttemptId(turnId, 1),
        null,
        null,
        wrongHandoffId,
        turnId,
        1,
        'legacy-invalid-continuation-handoff',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'running',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:01:00.000Z',
        '2026-04-10T00:01:00.000Z',
        null,
        null,
      );
      legacyDb.close();

      expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
        /invalid continuation_handoff_id provenance/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});
