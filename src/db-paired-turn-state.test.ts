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
  getPendingServiceHandoffs,
  getPairedTurnAttempts,
  getPairedTurnById,
  getPairedTurnsForTask,
  markPairedTurnRunning,
  releasePairedTaskExecutionLease,
  reservePairedTurnReservation,
} from './db.js';
import { initializeDatabaseSchema } from './db/bootstrap.js';
import { buildPairedTurnAttemptId } from './db/paired-turn-attempts.js';
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

describe('paired turn lifecycle states', () => {
  it('marks a delegated logical turn failed when its handoff fails', () => {
    const handoff = createServiceHandoff({
      chat_jid: 'dc:handoff-failed-turn',
      group_folder: 'handoff-failed-turn',
      paired_task_id: 'task-failed-reviewer-handoff',
      paired_task_updated_at: '2026-04-10T00:00:00.000Z',
      turn_intent_kind: 'reviewer-turn',
      turn_role: 'reviewer',
      source_service_id: CLAUDE_SERVICE_ID,
      target_service_id: CODEX_REVIEW_SERVICE_ID,
      source_role: 'owner',
      target_role: 'reviewer',
      source_agent_type: 'claude-code',
      target_agent_type: 'codex',
      prompt: 'failed reviewer handoff',
      intended_role: 'reviewer',
    });

    failServiceHandoff(handoff.id, 'Group not registered on target service');

    expect(
      getPairedTurnById(
        'task-failed-reviewer-handoff:2026-04-10T00:00:00.000Z:reviewer-turn',
      ),
    ).toMatchObject({
      turn_id:
        'task-failed-reviewer-handoff:2026-04-10T00:00:00.000Z:reviewer-turn',
      state: 'failed',
      last_error: 'Group not registered on target service',
    });
    expect(getPendingServiceHandoffs(CODEX_REVIEW_SERVICE_ID)).toEqual([]);
  });

  it('records queued and running logical turn state across reservation and lease claims', () => {
    const task: PairedTask = {
      id: 'task-paired-turn-state',
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
        runId: 'run-queued-turn',
      }),
    ).toBe(true);
    expect(
      getPairedTurnById(`${task.id}:${task.updated_at}:reviewer-turn`),
    ).toMatchObject({
      state: 'queued',
      attempt_no: 0,
      executor_service_id: null,
    });

    expect(
      claimPairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-running-turn',
      }),
    ).toBe(true);

    expect(
      getPairedTurnById(`${task.id}:${task.updated_at}:reviewer-turn`),
    ).toMatchObject({
      state: 'running',
      attempt_no: 1,
      executor_service_id: normalizeServiceId(SERVICE_ID),
    });
    expect(getPairedTurnsForTask(task.id)).toHaveLength(1);
  });

  it('does not create current-state shadow columns in fresh paired_turns schema', () => {
    const database = new Database(':memory:');

    try {
      initializeDatabaseSchema(database);

      const pairedTurnColumns = database
        .prepare(`PRAGMA table_info(paired_turns)`)
        .all() as Array<{ name: string }>;

      expect(
        pairedTurnColumns.some(
          (column) =>
            column.name === 'state' ||
            column.name === 'attempt_no' ||
            column.name === 'executor_service_id' ||
            column.name === 'executor_agent_type' ||
            column.name === 'completed_at' ||
            column.name === 'last_error',
        ),
      ).toBe(false);
    } finally {
      database.close();
    }
  });
});

describe('paired turn attempt history', () => {
  it('records execution attempt history across delegated failure and retry', () => {
    const task: PairedTask = {
      id: 'task-paired-turn-attempt-history',
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
        runId: 'run-attempt-history-queued-1',
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
        runId: 'run-attempt-history-running-1',
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
      prompt: 'retry reviewer via delegated handoff',
      intended_role: 'reviewer',
    });

    failServiceHandoff(handoff.id, 'delegated reviewer handoff failed');
    releasePairedTaskExecutionLease({
      taskId: task.id,
      runId: 'run-attempt-history-running-1',
    });

    expect(
      reservePairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-attempt-history-queued-2',
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
        runId: 'run-attempt-history-running-2',
      }),
    ).toBe(true);

    expect(
      getPairedTurnAttempts(`${task.id}:${task.updated_at}:reviewer-turn`),
    ).toMatchObject([
      {
        attempt_no: 1,
        parent_handoff_id: null,
        continuation_handoff_id: handoff.id,
        task_id: task.id,
        task_updated_at: task.updated_at,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'failed',
        executor_service_id: CODEX_REVIEW_SERVICE_ID,
        executor_agent_type: 'codex',
        last_error: 'delegated reviewer handoff failed',
      },
      {
        attempt_no: 2,
        parent_handoff_id: handoff.id,
        task_id: task.id,
        task_updated_at: task.updated_at,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'running',
        executor_service_id: normalizeServiceId(SERVICE_ID),
        executor_agent_type:
          normalizeServiceId(SERVICE_ID) === CLAUDE_SERVICE_ID
            ? 'claude-code'
            : 'codex',
        last_error: null,
      },
    ]);
  });

  it('reopens a completed reservation from the latest failed attempt even when paired_turns state is stale', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-paired-turn-failed-reopen-');
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      _initTestDatabaseFromFile(dbPath);

      const task: PairedTask = {
        id: 'task-paired-turn-failed-reopen',
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
          runId: 'run-failed-reopen-queued-1',
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
          runId: 'run-failed-reopen-running-1',
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
        error: 'failed reviewer attempt',
      });
      releasePairedTaskExecutionLease({
        taskId: task.id,
        runId: 'run-failed-reopen-running-1',
      });

      const rawDb = new Database(dbPath);
      rawDb.exec(
        `ALTER TABLE paired_turns ADD COLUMN state TEXT DEFAULT 'queued'`,
      );
      rawDb.exec(`ALTER TABLE paired_turns ADD COLUMN last_error TEXT`);
      rawDb
        .prepare(
          `
            UPDATE paired_turns
               SET state = 'queued',
                   last_error = NULL
             WHERE turn_id = ?
          `,
        )
        .run(turnIdentity.turnId);
      rawDb.close();

      expect(
        reservePairedTurnReservation({
          chatJid: task.chat_jid,
          taskId: task.id,
          taskStatus: task.status,
          roundTripCount: task.round_trip_count,
          taskUpdatedAt: task.updated_at,
          intentKind: 'reviewer-turn',
          runId: 'run-failed-reopen-queued-2',
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
          runId: 'run-failed-reopen-running-2',
        }),
      ).toBe(true);

      expect(getPairedTurnById(turnIdentity.turnId)).toMatchObject({
        state: 'running',
        attempt_no: 2,
      });
      expect(getPairedTurnAttempts(turnIdentity.turnId)).toMatchObject([
        {
          attempt_no: 1,
          state: 'failed',
          last_error: 'failed reviewer attempt',
        },
        {
          attempt_no: 2,
          state: 'running',
          active_run_id: 'run-failed-reopen-running-2',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });
});

describe('paired turn delegated continuation', () => {
  it('keeps delegated continuation on attempt 1 even when paired_turns attempt_no is stale', () => {
    const tempDir = fs.mkdtempSync(
      '/tmp/ejclaw-paired-turn-attempt-cache-drift-',
    );
    const dbPath = path.join(tempDir, 'messages.db');

    try {
      _initTestDatabaseFromFile(dbPath);

      const task: PairedTask = {
        id: 'task-paired-turn-attempt-cache-drift',
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
          runId: 'run-attempt-cache-drift-queued-1',
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
          runId: 'run-attempt-cache-drift-running-1',
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
               SET attempt_no = 99
             WHERE turn_id = ?
          `,
        )
        .run(turnId);
      rawDb.close();

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
        prompt: 'delegate reviewer with stale aggregate attempt cache',
        intended_role: 'reviewer',
      });

      expect(handoff.turn_attempt_no).toBe(1);
      expect(getPairedTurnById(turnId)).toMatchObject({
        state: 'delegated',
        attempt_no: 1,
        executor_service_id: CODEX_REVIEW_SERVICE_ID,
      });
      expect(getPairedTurnAttempts(turnId)).toMatchObject([
        {
          attempt_no: 1,
          continuation_handoff_id: handoff.id,
          state: 'delegated',
          executor_service_id: CODEX_REVIEW_SERVICE_ID,
          executor_agent_type: 'codex',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('drops legacy next_parent_handoff_id scratch state on re-init and keeps retry lineage on attempt rows', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-attempt-parent-lineage-');
    const dbPath = path.join(tempDir, 'messages.db');

    _initTestDatabaseFromFile(dbPath);

    const task: PairedTask = {
      id: 'task-attempt-parent-lineage',
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
        runId: 'run-attempt-parent-lineage-queued-1',
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
        runId: 'run-attempt-parent-lineage-running-1',
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
      prompt: 'derive retry parent from previous attempt row',
      intended_role: 'reviewer',
    });

    failServiceHandoff(handoff.id, 'delegated reviewer handoff failed');
    releasePairedTaskExecutionLease({
      taskId: task.id,
      runId: 'run-attempt-parent-lineage-running-1',
    });

    const turnId = `${task.id}:${task.updated_at}:reviewer-turn`;
    const rawDb = new Database(dbPath);
    rawDb.exec(
      `ALTER TABLE paired_turns ADD COLUMN next_parent_handoff_id INTEGER`,
    );
    rawDb
      .prepare(
        `
          UPDATE paired_turns
             SET next_parent_handoff_id = ?
           WHERE turn_id = ?
        `,
      )
      .run(handoff.id + 9999, turnId);
    rawDb.close();

    _initTestDatabaseFromFile(dbPath);

    const rebuiltDb = new Database(dbPath);
    const pairedTurnColumns = rebuiltDb
      .prepare(`PRAGMA table_info(paired_turns)`)
      .all() as Array<{ name: string }>;
    rebuiltDb.close();

    expect(
      pairedTurnColumns.some(
        (column) => column.name === 'next_parent_handoff_id',
      ),
    ).toBe(false);

    expect(
      reservePairedTurnReservation({
        chatJid: task.chat_jid,
        taskId: task.id,
        taskStatus: task.status,
        roundTripCount: task.round_trip_count,
        taskUpdatedAt: task.updated_at,
        intentKind: 'reviewer-turn',
        runId: 'run-attempt-parent-lineage-queued-2',
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
        runId: 'run-attempt-parent-lineage-running-2',
      }),
    ).toBe(true);

    expect(getPairedTurnAttempts(turnId)).toMatchObject([
      {
        attempt_no: 1,
        continuation_handoff_id: handoff.id,
        state: 'failed',
      },
      {
        attempt_no: 2,
        parent_handoff_id: handoff.id,
        state: 'running',
      },
    ]);
  });
});

describe('paired turn same-run continuation', () => {
  it('keeps attempt 1 when a delegated handoff continues on the target executor', () => {
    const handoff = createServiceHandoff({
      chat_jid: 'dc:handoff-attempt-continuation',
      group_folder: 'handoff-attempt-continuation',
      paired_task_id: 'task-handoff-attempt-continuation',
      paired_task_updated_at: '2026-04-10T00:00:00.000Z',
      turn_intent_kind: 'reviewer-turn',
      turn_role: 'reviewer',
      source_service_id: CLAUDE_SERVICE_ID,
      target_service_id: CODEX_REVIEW_SERVICE_ID,
      source_role: 'owner',
      target_role: 'reviewer',
      source_agent_type: 'claude-code',
      target_agent_type: 'codex',
      prompt: 'continue delegated reviewer handoff',
      intended_role: 'reviewer',
    });

    expect(handoff.turn_id).toBe(
      'task-handoff-attempt-continuation:2026-04-10T00:00:00.000Z:reviewer-turn',
    );

    markPairedTurnRunning({
      turnIdentity: {
        turnId: handoff.turn_id!,
        taskId: 'task-handoff-attempt-continuation',
        taskUpdatedAt: '2026-04-10T00:00:00.000Z',
        intentKind: 'reviewer-turn',
        role: 'reviewer',
      },
      executorServiceId: CODEX_REVIEW_SERVICE_ID,
      executorAgentType: 'codex',
      runId: 'run-handoff-continuation-1',
    });

    expect(getPairedTurnById(handoff.turn_id!)).toMatchObject({
      state: 'running',
      attempt_no: 1,
      executor_service_id: CODEX_REVIEW_SERVICE_ID,
      executor_agent_type: 'codex',
    });
    expect(getPairedTurnAttempts(handoff.turn_id!)).toMatchObject([
      {
        attempt_no: 1,
        parent_handoff_id: null,
        continuation_handoff_id: handoff.id,
        task_id: 'task-handoff-attempt-continuation',
        task_updated_at: '2026-04-10T00:00:00.000Z',
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
        state: 'running',
        executor_service_id: CODEX_REVIEW_SERVICE_ID,
        executor_agent_type: 'codex',
        active_run_id: 'run-handoff-continuation-1',
        last_error: null,
      },
    ]);
  });

  it('drops legacy paired_turn active_run_id scratch state on re-init and keeps same-run continuation on attempt rows', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-current-run-write-drift-');
    const dbPath = path.join(tempDir, 'messages.db');

    const turnIdentity = buildPairedTurnIdentity({
      taskId: 'task-current-run-drift',
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
        runId: 'run-current-run-drift-1',
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
            UPDATE paired_turns
               SET active_run_id = ?
             WHERE turn_id = ?
          `,
        )
        .run('stale-run-id', turnIdentity.turnId);
      rawDb.close();

      _initTestDatabaseFromFile(dbPath);

      const rebuiltDb = new Database(dbPath);
      const pairedTurnColumns = rebuiltDb
        .prepare(`PRAGMA table_info(paired_turns)`)
        .all() as Array<{ name: string }>;
      rebuiltDb.close();

      expect(
        pairedTurnColumns.some((column) => column.name === 'active_run_id'),
      ).toBe(false);

      markPairedTurnRunning({
        turnIdentity,
        executorServiceId: CODEX_REVIEW_SERVICE_ID,
        executorAgentType: 'codex',
        runId: 'run-current-run-drift-1',
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
          active_run_id: 'run-current-run-drift-1',
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('backfills running attempt active_run_id from lease provenance before legacy paired_turn scratch on re-init', () => {
    const tempDir = fs.mkdtempSync('/tmp/ejclaw-current-run-lease-backfill-');
    const dbPath = path.join(tempDir, 'messages.db');

    const turnIdentity = buildPairedTurnIdentity({
      taskId: 'task-current-run-lease-backfill',
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
          'dc:current-run-lease-backfill',
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
});
