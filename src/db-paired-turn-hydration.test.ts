import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  _initTestDatabaseFromFile,
  createPairedTask,
  createServiceHandoff,
  claimPairedTurnReservation,
  failPairedTurn,
  failServiceHandoff,
  getPairedTurnAttempts,
  getPairedTurnById,
  getPairedTurnsForTask,
  markPairedTurnRunning,
  releasePairedTaskExecutionLease,
  reservePairedTurnReservation,
} from './db.js';
import {
  buildPairedTurnAttemptId,
  buildPairedTurnAttemptParentId,
} from './db/paired-turn-attempts.js';
import { buildPairedTurnIdentity } from './paired-turn-identity.js';
import {
  CLAUDE_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  SERVICE_ID,
  normalizeServiceId,
} from './config.js';
import type { PairedTask } from './types.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('paired turn re-init continuation', () => {
  it('keeps attempt 1 when same-run continuation follows lease-backed active_run_id after re-init', () => {
    const tempDir = fs.mkdtempSync(
      '/tmp/ejclaw-current-run-lease-continuation-',
    );
    const dbPath = path.join(tempDir, 'messages.db');

    const turnIdentity = buildPairedTurnIdentity({
      taskId: 'task-current-run-lease-continuation',
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });

    try {
      _initTestDatabaseFromFile(dbPath);

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-correct',
      });

      const rawDb = new Database(dbPath);
      rawDb.exec(`
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_insert;
        DROP TRIGGER IF EXISTS paired_turn_attempts_validate_update;
      `);
      rawDb.exec(`ALTER TABLE paired_turns ADD COLUMN active_run_id TEXT`);
      rawDb
        .prepare(
          `
            UPDATE paired_turn_attempts
               SET active_run_id = NULL
             WHERE turn_id = ?
               AND attempt_no = 1
          `,
        )
        .run(turnIdentity.turnId);
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET active_run_id = ?
             WHERE turn_id = ?
          `,
        )
        .run('run-stale', turnIdentity.turnId);
      rawDb
        .prepare(
          `
            INSERT OR REPLACE INTO paired_task_execution_leases (
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
          turnIdentity.taskId,
          'dc:current-run-lease-continuation',
          'reviewer',
          turnIdentity.turnId,
          buildPairedTurnAttemptId(turnIdentity.turnId, 1),
          1,
          turnIdentity.intentKind,
          'run-correct',
          CODEX_REVIEW_SERVICE_ID,
          'review_ready',
          turnIdentity.taskUpdatedAt,
          '2026-04-10T00:00:05.000Z',
          '2026-04-10T00:00:10.000Z',
          '2026-04-10T01:00:00.000Z',
        );
      rawDb.close();

      _initTestDatabaseFromFile(dbPath);

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-correct',
      });

      expect(getPairedTurnById(turnIdentity.turnId)).toMatchObject({
        state: 'running',
        attempt_no: 1,
      });
      expect(getPairedTurnAttempts(turnIdentity.turnId)).toMatchObject([
        {
          attempt_no: 1,
          state: 'running',
          executor_service_id: CODEX_REVIEW_SERVICE_ID,
          executor_agent_type: 'codex',
          active_run_id: 'run-correct',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('keeps attempt 1 when paired_turn state drifts away from the current attempt row', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-current-state-write-drift-');
    const dbPath = path.join(tempDir, 'messages.db');

    const turnIdentity = buildPairedTurnIdentity({
      taskId: 'task-current-state-drift',
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });

    try {
      _initTestDatabaseFromFile(dbPath);

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-current-state-drift-1',
      });

      const rawDb = new Database(dbPath);
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN state TEXT DEFAULT 'queued'`,
      );
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET state = 'queued'
             WHERE turn_id = ?
          `,
        )
        .run(turnIdentity.turnId);
      rawDb.close();

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-current-state-drift-1',
      });

      expect(getPairedTurnById(turnIdentity.turnId)).toMatchObject({
        state: 'running',
        attempt_no: 1,
      });
      expect(getPairedTurnAttempts(turnIdentity.turnId)).toMatchObject([
        {
          attempt_no: 1,
          state: 'running',
          executor_service_id: CODEX_REVIEW_SERVICE_ID,
          executor_agent_type: 'codex',
          active_run_id: 'run-current-state-drift-1',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});

describe('paired turn attempt hydration', () => {
  it('hydrates paired turn reads from the latest attempt row when paired_turn cache is stale', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-current-state-read-hydration-');
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      _initTestDatabaseFromFile(dbPath);

      const task: PairedTask = {
        id: 'task-current-state-read-hydration',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: CLAUDE_SERVICE_ID,
        reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
        owner_agent_type: 'claude-code',
        reviewer_agent_type: 'codex',
        arbiter_agent_type: null,
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        review_requested_at: '2026-04-10T00:00:00.000Z',
        round_trip_count: 1,
        status: 'review_ready' as const,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      };
      createPairedTask(task);

      expect(
        reservePairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-current-state-read-hydration-queued-1',
        }),
      ).toBe(true);
      expect(
        claimPairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-current-state-read-hydration-running-1',
        }),
      ).toBe(true);

      const turnIdentity = buildPairedTurnIdentity({
        taskId: task.id,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        role: 'reviewer',
      });
      failPairedTurn({
        turnIdentity,
        error: 'failed reviewer read hydration attempt',
      });

      const rawDb = new Database(dbPath);
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN state TEXT DEFAULT 'queued'`,
      );
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 0`,
      );
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN executor_service_id TEXT`,
      );
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN executor_agent_type TEXT`,
      );
      rawDb.exec(`ALTER TABLE paired_turns ADD COLUMN last_error TEXT`);
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET task_id = ?,
                   state = 'queued',
                   attempt_no = 99,
                   executor_service_id = ?,
                   executor_agent_type = ?,
                   last_error = NULL
             WHERE turn_id = ?
          `,
        )
        .run(
          'task-stale-current-state-cache',
          'stale-service',
          'claude-code',
          turnIdentity.turnId,
        );
      rawDb.close();

      expect(getPairedTurnById(turnIdentity.turnId)).toMatchObject({
        turn_id: turnIdentity.turnId,
        task_id: task.id,
        task_updated_at: task.updated_at,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'failed',
        attempt_no: 1,
        executor_service_id: normalizeServiceId(SERVICE_ID),
        last_error: 'failed reviewer read hydration attempt',
      });
      expect(getPairedTurnsForTask(task.id)).toMatchObject([
        {
          turn_id: turnIdentity.turnId,
          task_id: task.id,
          task_updated_at: task.updated_at,
          role: 'reviewer',
          intent_kind: 'reviewer-turn',
          state: 'failed',
          attempt_no: 1,
          executor_service_id: normalizeServiceId(SERVICE_ID),
          last_error: 'failed reviewer read hydration attempt',
        },
      ]);
      expect(getPairedTurnsForTask('task-stale-current-state-cache')).toEqual(
        [],
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});

describe('paired turn aggregate drift hydration', () => {
  it('keeps latest attempt hydration when a paired_turn aggregate current attempt lags the latest attempt row', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-current-attempt-drift-');
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      _initTestDatabaseFromFile(dbPath);

      const task: PairedTask = {
        id: 'task-current-attempt-drift',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: CLAUDE_SERVICE_ID,
        reviewer_service_id: CODEX_REVIEW_SERVICE_ID,
        owner_agent_type: 'claude-code',
        reviewer_agent_type: 'codex',
        arbiter_agent_type: null,
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        review_requested_at: '2026-04-10T00:00:00.000Z',
        round_trip_count: 1,
        status: 'review_ready' as const,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        updated_at: '2026-04-10T00:00:00.000Z',
      };
      createPairedTask(task);

      expect(
        reservePairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-current-attempt-drift-queued-1',
        }),
      ).toBe(true);
      expect(
        claimPairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-current-attempt-drift-running-1',
        }),
      ).toBe(true);

      const handoff = createServiceHandoff({
        chat_jid: task.chat_jid,
        group_folder: task.group_folder,
        paired_task_id: task.id,
        paired_task_updated_at: task.updated_at,
        turn_intent_kind: 'reviewer-turn',
        turn_role: 'reviewer',
        source_service_id: CLAUDE_SERVICE_ID,
        target_service_id: CODEX_REVIEW_SERVICE_ID,
        source_role: 'owner',
        target_role: 'reviewer',
        source_agent_type: 'claude-code',
        target_agent_type: 'codex',
        prompt: 'drift latest attempt row away from aggregate',
        intended_role: 'reviewer',
      });

      failServiceHandoff(handoff.id, 'delegated reviewer handoff failed');
      releasePairedTaskExecutionLease({
        taskId: task.id,
        runId: 'run-current-attempt-drift-running-1',
      });

      expect(
        reservePairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-current-attempt-drift-queued-2',
        }),
      ).toBe(true);
      expect(
        claimPairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-current-attempt-drift-running-2',
        }),
      ).toBe(true);

      const turnId = `${task.id}:${task.updated_at}:reviewer-turn`;
      const rawDb = new Database(dbPath);
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 0`,
      );
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET attempt_no = 1
             WHERE turn_id = ?
          `,
        )
        .run(turnId);
      rawDb.close();

      _initTestDatabaseFromFile(dbPath);

      expect(getPairedTurnById(turnId)).toMatchObject({
        turn_id: turnId,
        task_id: task.id,
        task_updated_at: task.updated_at,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'running',
        attempt_no: 2,
      });
      expect(getPairedTurnAttempts(turnId)).toMatchObject([
        {
          attempt_no: 1,
          state: 'failed',
          continuation_handoff_id: handoff.id,
        },
        {
          attempt_no: 2,
          state: 'running',
          active_run_id: 'run-current-attempt-drift-running-2',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('keeps latest attempt hydration when a paired_turn aggregate state drifts from a running attempt row', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-current-state-drift-');
    const dbPath = path.join(tempDir, 'messages.db');

    const turnIdentity = buildPairedTurnIdentity({
      taskId: 'task-current-state-drift',
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });

    try {
      _initTestDatabaseFromFile(dbPath);

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-current-state-drift-1',
      });

      const rawDb = new Database(dbPath);
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN state TEXT DEFAULT 'queued'`,
      );
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET state = 'queued'
             WHERE turn_id = ?
          `,
        )
        .run(turnIdentity.turnId);
      rawDb.close();

      _initTestDatabaseFromFile(dbPath);

      expect(getPairedTurnById(turnIdentity.turnId)).toMatchObject({
        turn_id: turnIdentity.turnId,
        task_id: turnIdentity.taskId,
        task_updated_at: turnIdentity.taskUpdatedAt,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'running',
        attempt_no: 1,
        executor_service_id: CODEX_REVIEW_SERVICE_ID,
        executor_agent_type: 'codex',
      });
      expect(getPairedTurnAttempts(turnIdentity.turnId)).toMatchObject([
        {
          attempt_no: 1,
          state: 'running',
          active_run_id: 'run-current-state-drift-1',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});

describe('paired turn attempt lineage', () => {
  it('fails init when a legacy paired_turn aggregate implies a non-contiguous attempt lineage', () => {
    const tempDir = fs.mkdtempSync(path.join('/tmp', 'ejclaw-paired-attempt-'));
    const dbPath = path.join(tempDir, 'paired-attempts.db');

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
          'legacy-task:2026-04-10T00:00:00.000Z:reviewer-turn',
          'legacy-task',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          2,
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T01:00:00.000Z',
          '2026-04-10T01:00:00.000Z',
          'legacy attempt failure',
        );
      legacyDb.close();

      expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
        /must preserve contiguous parent lineage/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('records parent_attempt_id when a retry creates a new attempt', () => {
    const turnIdentity = buildPairedTurnIdentity({
      taskId: 'parent-attempt-task',
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });

    markPairedTurnRunning({
      turnIdentity,
      executorServiceId: CODEX_REVIEW_SERVICE_ID,
      runId: 'run-1',
    });
    failPairedTurn({
      turnIdentity,
      error: 'attempt 1 failed',
    });
    markPairedTurnRunning({
      turnIdentity,
      executorServiceId: CODEX_REVIEW_SERVICE_ID,
      runId: 'run-2',
    });

    expect(getPairedTurnAttempts(turnIdentity.turnId)).toEqual([
      expect.objectContaining({
        attempt_id: buildPairedTurnAttemptId(turnIdentity.turnId, 1),
        parent_attempt_id: null,
        attempt_no: 1,
        state: 'failed',
      }),
      expect.objectContaining({
        attempt_id: buildPairedTurnAttemptId(turnIdentity.turnId, 2),
        parent_attempt_id: buildPairedTurnAttemptParentId(
          turnIdentity.turnId,
          2,
        ),
        attempt_no: 2,
        state: 'running',
      }),
    ]);
  });
});

describe('paired turn legacy lineage backfill', () => {
  it('backfills parent_attempt_id for legacy multi-attempt rows during init', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-parent-attempt-backfill-'),
    );
    const dbPath = path.join(tempDir, 'parent-attempt-backfill.db');
    const turnId =
      'legacy-parent-attempt:2026-04-10T00:00:00.000Z:reviewer-turn';

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
          turnId,
          'legacy-parent-attempt',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          2,
          '2026-04-10T00:01:00.000Z',
          '2026-04-10T00:02:40.000Z',
          '2026-04-10T00:02:40.000Z',
          'attempt 2 failed',
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
        turnId,
        1,
        'legacy-parent-attempt',
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
        turnId,
        2,
        'legacy-parent-attempt',
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
      legacyDb.close();

      _initTestDatabaseFromFile(dbPath);

      const rawDb = new Database(dbPath, { readonly: true });
      expect(
        rawDb
          .prepare(
            `
              SELECT attempt_no, attempt_id, parent_attempt_id
                FROM paired_turn_attempts
               WHERE turn_id = ?
               ORDER BY attempt_no ASC
            `,
          )
          .all(turnId),
      ).toEqual([
        {
          attempt_no: 1,
          attempt_id: buildPairedTurnAttemptId(turnId, 1),
          parent_attempt_id: null,
        },
        {
          attempt_no: 2,
          attempt_id: buildPairedTurnAttemptId(turnId, 2),
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

describe('paired turn legacy lineage validation', () => {
  it('fails init when legacy attempt lineage skips the previous attempt', () => {
    const tempDir = fs.mkdtempSync(
      path.join('/tmp', 'ejclaw-parent-attempt-gap-'),
    );
    const dbPath = path.join(tempDir, 'parent-attempt-gap.db');
    const turnId = 'legacy-parent-gap:2026-04-10T00:00:00.000Z:reviewer-turn';

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
          turnId,
          'legacy-parent-gap',
          '2026-04-10T00:00:00.000Z',
          'reviewer',
          'reviewer-turn',
          'failed',
          CODEX_REVIEW_SERVICE_ID,
          'codex',
          3,
          '2026-04-10T00:00:00.000Z',
          '2026-04-10T00:03:00.000Z',
          '2026-04-10T00:03:00.000Z',
          'attempt 3 failed',
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
        turnId,
        1,
        'legacy-parent-gap',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'delegated',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:01:00.000Z',
        '2026-04-10T00:01:30.000Z',
        '2026-04-10T00:01:30.000Z',
        'attempt 1 delegated',
      );
      insertAttempt.run(
        turnId,
        3,
        'legacy-parent-gap',
        '2026-04-10T00:00:00.000Z',
        'reviewer',
        'reviewer-turn',
        'failed',
        CODEX_REVIEW_SERVICE_ID,
        'codex',
        '2026-04-10T00:03:00.000Z',
        '2026-04-10T00:03:20.000Z',
        '2026-04-10T00:03:20.000Z',
        'attempt 3 failed',
      );
      legacyDb.close();

      expect(() => _initTestDatabaseFromFile(dbPath)).toThrow(
        /invalid parent_attempt_id provenance/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});
