import { Database } from 'bun:sqlite';

import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import { initializeDatabaseSchema } from './db/bootstrap.js';
import {
  buildPairedTurnAttemptId,
  buildPairedTurnAttemptParentId,
} from './db/paired-turn-attempts.js';
import { buildPairedTurnIdentity } from './paired-turn-identity.js';
import { CLAUDE_SERVICE_ID, CODEX_REVIEW_SERVICE_ID } from './config.js';
import { insertPairedTurnIdentityRow } from '../test/helpers/db-test-utils.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('turn attempt provenance foreign keys', () => {
  it('uses real foreign keys to reject orphan attempt provenance when triggers are absent', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);
      database.exec(`
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
        DROP TRIGGER IF EXISTS service_handoffs_validate_attempt_insert;
        DROP TRIGGER IF EXISTS service_handoffs_validate_attempt_update;
      `);

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
                created_at,
                updated_at,
                completed_at,
                last_error
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            buildPairedTurnAttemptId(
              'orphan-turn:2026-04-10T00:00:00.000Z:reviewer-turn',
              1,
            ),
            'orphan-turn:2026-04-10T00:00:00.000Z:reviewer-turn',
            1,
            'orphan-task',
            '2026-04-10T00:00:00.000Z',
            'reviewer',
            'reviewer-turn',
            'failed',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            '2026-04-10T00:00:00.000Z',
            '2026-04-10T00:01:00.000Z',
            '2026-04-10T00:01:00.000Z',
            'orphan attempt',
          ),
      ).toThrow(/FOREIGN KEY constraint failed/);

      const turnId = 'fk-enforced-turn:2026-04-10T00:00:00.000Z:reviewer-turn';
      insertPairedTurnIdentityRow(database, {
        turnId,
        taskId: 'fk-enforced-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
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
          'fk-enforced-task',
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
      expect(() =>
        database
          .prepare(
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
          )
          .run(
            buildPairedTurnAttemptId(turnId, 2),
            buildPairedTurnAttemptParentId(turnId, 2),
            999,
            turnId,
            2,
            'fk-enforced-task',
            '2026-04-10T00:00:00.000Z',
            'reviewer',
            'reviewer-turn',
            'failed',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            '2026-04-10T00:02:00.000Z',
            '2026-04-10T00:02:00.000Z',
            '2026-04-10T00:02:00.000Z',
            'orphan parent handoff',
          ),
      ).toThrow(/FOREIGN KEY constraint failed/);

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
            'fk-enforced-task',
            '2026-04-10T00:00:00.000Z',
            turnId,
            2,
            'reviewer-turn',
            'reviewer',
            CLAUDE_SERVICE_ID,
            CODEX_REVIEW_SERVICE_ID,
            'owner',
            'claude-code',
            'reviewer',
            'codex',
            'orphan handoff attempt reference',
            'failed',
            'reviewer',
            '2026-04-10T00:00:30.000Z',
          ),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      database.close();
    }
  });
});

describe('turn attempt lineage direct insert guards', () => {
  it('rejects direct inserts when attempt lineage skips the previous attempt', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);

      const turnIdentity = buildPairedTurnIdentity({
        taskId: 'trigger-parent-gap-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
      });

      insertPairedTurnIdentityRow(database, {
        turnId: turnIdentity.turnId,
        taskId: turnIdentity.taskId,
        taskUpdatedAt: turnIdentity.taskUpdatedAt,
        role: turnIdentity.role,
        intentKind: turnIdentity.intentKind,
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:03:00.000Z',
      });

      expect(() =>
        database
          .prepare(
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
          )
          .run(
            buildPairedTurnAttemptId(turnIdentity.turnId, 3),
            null,
            turnIdentity.turnId,
            3,
            turnIdentity.taskId,
            turnIdentity.taskUpdatedAt,
            turnIdentity.role,
            turnIdentity.intentKind,
            'failed',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            '2026-04-10T00:03:00.000Z',
            '2026-04-10T00:03:20.000Z',
            '2026-04-10T00:03:20.000Z',
            'attempt 3 failed',
          ),
      ).toThrow(/must preserve contiguous parent lineage/);
    } finally {
      database.close();
    }
  });
});

describe('parent handoff direct insert guards', () => {
  it('rejects direct inserts when parent_handoff_id does not belong to the previous attempt of the same turn', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);

      const otherTurnId =
        'other-handoff-turn:2026-04-10T00:00:00.000Z:reviewer-turn';
      insertPairedTurnIdentityRow(database, {
        turnId: otherTurnId,
        taskId: 'other-handoff-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:30.000Z',
      });
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
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(otherTurnId, 1),
          otherTurnId,
          1,
          'other-handoff-task',
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
          'other-handoff-task',
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
          'other handoff',
          'failed',
          'reviewer',
          '2026-04-10T00:00:30.000Z',
        );
      const wrongHandoffId = (
        database.prepare('SELECT last_insert_rowid() AS id').get() as {
          id: number;
        }
      ).id;

      const turnIdentity = buildPairedTurnIdentity({
        taskId: 'trigger-parent-handoff-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
      });
      insertPairedTurnIdentityRow(database, {
        turnId: turnIdentity.turnId,
        taskId: turnIdentity.taskId,
        taskUpdatedAt: turnIdentity.taskUpdatedAt,
        role: turnIdentity.role,
        intentKind: turnIdentity.intentKind,
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
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
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(turnIdentity.turnId, 1),
          turnIdentity.turnId,
          1,
          turnIdentity.taskId,
          turnIdentity.taskUpdatedAt,
          turnIdentity.role,
          turnIdentity.intentKind,
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:01:00.000Z',
          '2026-04-10T00:01:00.000Z',
          'attempt 1 failed',
        );

      expect(() =>
        database
          .prepare(
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
          )
          .run(
            buildPairedTurnAttemptId(turnIdentity.turnId, 2),
            buildPairedTurnAttemptParentId(turnIdentity.turnId, 2),
            wrongHandoffId,
            turnIdentity.turnId,
            2,
            turnIdentity.taskId,
            turnIdentity.taskUpdatedAt,
            turnIdentity.role,
            turnIdentity.intentKind,
            'running',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            '2026-04-10T00:02:00.000Z',
            '2026-04-10T00:02:00.000Z',
            null,
            null,
          ),
      ).toThrow(
        /parent_handoff_id must reference the previous attempt handoff of the same turn/,
      );
    } finally {
      database.close();
    }
  });
});

describe('completed parent handoff direct insert guards', () => {
  it('rejects direct inserts when parent_handoff_id points to a completed previous-attempt handoff', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);

      const turnIdentity = buildPairedTurnIdentity({
        taskId: 'trigger-completed-parent-handoff-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
      });
      insertPairedTurnIdentityRow(database, {
        turnId: turnIdentity.turnId,
        taskId: turnIdentity.taskId,
        taskUpdatedAt: turnIdentity.taskUpdatedAt,
        role: turnIdentity.role,
        intentKind: turnIdentity.intentKind,
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });
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
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(turnIdentity.turnId, 1),
          turnIdentity.turnId,
          1,
          turnIdentity.taskId,
          turnIdentity.taskUpdatedAt,
          turnIdentity.role,
          turnIdentity.intentKind,
          'completed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:01:00.000Z',
          '2026-04-10T00:01:00.000Z',
          null,
        );
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
              created_at,
              completed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          'group@test',
          'test-group',
          turnIdentity.taskId,
          turnIdentity.taskUpdatedAt,
          turnIdentity.turnId,
          buildPairedTurnAttemptId(turnIdentity.turnId, 1),
          1,
          turnIdentity.intentKind,
          turnIdentity.role,
          CLAUDE_SERVICE_ID,
          CODEX_REVIEW_SERVICE_ID,
          'owner',
          'claude-code',
          turnIdentity.role,
          'codex',
          'completed handoff cannot seed retry lineage',
          'completed',
          turnIdentity.role,
          '2026-04-10T00:00:20.000Z',
          '2026-04-10T00:00:30.000Z',
        );
      const completedHandoffId = (
        database.prepare('SELECT last_insert_rowid() AS id').get() as {
          id: number;
        }
      ).id;

      expect(() =>
        database
          .prepare(
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
          )
          .run(
            buildPairedTurnAttemptId(turnIdentity.turnId, 2),
            buildPairedTurnAttemptParentId(turnIdentity.turnId, 2),
            completedHandoffId,
            turnIdentity.turnId,
            2,
            turnIdentity.taskId,
            turnIdentity.taskUpdatedAt,
            turnIdentity.role,
            turnIdentity.intentKind,
            'running',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            '2026-04-10T00:02:00.000Z',
            '2026-04-10T00:02:00.000Z',
            null,
            null,
          ),
      ).toThrow(
        /parent_handoff_id must reference the previous attempt handoff of the same turn/,
      );
    } finally {
      database.close();
    }
  });
});

describe('continuation handoff direct insert guards', () => {
  it('rejects direct inserts when continuation_handoff_id does not belong to the same attempt', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);

      const otherTurnId =
        'other-continuation-handoff-turn:2026-04-10T00:00:00.000Z:reviewer-turn';
      insertPairedTurnIdentityRow(database, {
        turnId: otherTurnId,
        taskId: 'other-continuation-handoff-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:00:30.000Z',
      });
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
              created_at,
              updated_at,
              completed_at,
              last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          buildPairedTurnAttemptId(otherTurnId, 1),
          otherTurnId,
          1,
          'other-continuation-handoff-task',
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
          'other-continuation-handoff-task',
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
          'other continuation handoff',
          'claimed',
          'reviewer',
          '2026-04-10T00:00:20.000Z',
        );
      const wrongContinuationHandoffId = (
        database.prepare('SELECT last_insert_rowid() AS id').get() as {
          id: number;
        }
      ).id;

      const turnIdentity = buildPairedTurnIdentity({
        taskId: 'trigger-continuation-handoff-task',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intentKind: 'reviewer-turn',
      });
      insertPairedTurnIdentityRow(database, {
        turnId: turnIdentity.turnId,
        taskId: turnIdentity.taskId,
        taskUpdatedAt: turnIdentity.taskUpdatedAt,
        role: turnIdentity.role,
        intentKind: turnIdentity.intentKind,
        createdAt: '2026-04-10T00:00:00.000Z',
        updatedAt: '2026-04-10T00:01:00.000Z',
      });

      expect(() =>
        database
          .prepare(
            `
              INSERT INTO paired_turn_attempts (
                attempt_id,
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
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            buildPairedTurnAttemptId(turnIdentity.turnId, 1),
            wrongContinuationHandoffId,
            turnIdentity.turnId,
            1,
            turnIdentity.taskId,
            turnIdentity.taskUpdatedAt,
            turnIdentity.role,
            turnIdentity.intentKind,
            'running',
            CODEX_REVIEW_SERVICE_ID,
            'codex',
            '2026-04-10T00:01:00.000Z',
            '2026-04-10T00:01:00.000Z',
            null,
            null,
          ),
      ).toThrow(
        /continuation_handoff_id must reference a handoff of the same attempt/,
      );
    } finally {
      database.close();
    }
  });
});
