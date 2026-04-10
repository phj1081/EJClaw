import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  SERVICE_ID,
  normalizeServiceId,
} from './config.js';
import {
  _initTestDatabase,
  _initTestDatabaseFromFile,
  createPairedTask,
  createServiceHandoff,
  failServiceHandoff,
  getPairedTaskById,
  getPairedTurnAttempts,
  getPairedTurnById,
  releasePairedTaskExecutionLease,
} from './db.js';
import {
  buildPairedFollowUpKey,
  claimPairedTurnExecution,
  resetPairedFollowUpScheduleState,
  schedulePairedFollowUpOnce,
} from './paired-follow-up-scheduler.js';

const CURRENT_SERVICE_ID = normalizeServiceId(SERVICE_ID);
const CURRENT_AGENT_TYPE =
  CURRENT_SERVICE_ID === CLAUDE_SERVICE_ID ? 'claude-code' : 'codex';
const OTHER_SERVICE_ID =
  CURRENT_SERVICE_ID === CLAUDE_SERVICE_ID
    ? CODEX_MAIN_SERVICE_ID
    : CLAUDE_SERVICE_ID;
const OTHER_AGENT_TYPE =
  OTHER_SERVICE_ID === CLAUDE_SERVICE_ID ? 'claude-code' : 'codex';

function createLegacyLeaseDatabase(args: {
  dbPath: string;
  taskId: string;
  role?: 'owner' | 'reviewer' | 'arbiter';
  intentKind?:
    | 'owner-turn'
    | 'reviewer-turn'
    | 'arbiter-turn'
    | 'owner-follow-up'
    | 'finalize-owner-turn';
  claimedRunId?: string;
  taskStatus?: string;
  reviewerServiceId: string;
  reviewerAgentType: 'codex' | 'claude-code';
  ownerServiceId?: string;
  ownerAgentType?: 'codex' | 'claude-code';
  arbiterServiceId?: string;
  arbiterAgentType?: 'codex' | 'claude-code';
}): void {
  const legacyDb = new Database(args.dbPath);
  legacyDb.exec(`
    CREATE TABLE paired_tasks (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      owner_service_id TEXT NOT NULL,
      reviewer_service_id TEXT NOT NULL,
      arbiter_service_id TEXT,
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
      updated_at TEXT NOT NULL
    );
    CREATE TABLE paired_task_execution_leases (
      task_id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      role TEXT NOT NULL,
      intent_kind TEXT NOT NULL,
      claimed_run_id TEXT NOT NULL,
      task_status TEXT NOT NULL,
      task_updated_at TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      CHECK (role IN ('owner', 'reviewer', 'arbiter')),
      CHECK (
        intent_kind IN (
          'owner-turn',
          'reviewer-turn',
          'arbiter-turn',
          'owner-follow-up',
          'finalize-owner-turn'
        )
      )
    );
  `);
  legacyDb
    .prepare(
      `INSERT INTO paired_tasks (
        id,
        chat_jid,
        group_folder,
        owner_service_id,
        reviewer_service_id,
        arbiter_service_id,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.taskId,
      'group@test',
      'test-group',
      args.ownerServiceId ?? OTHER_SERVICE_ID,
      args.reviewerServiceId,
      args.arbiterServiceId ?? null,
      args.ownerAgentType ?? OTHER_AGENT_TYPE,
      args.reviewerAgentType,
      args.arbiterAgentType ?? null,
      null,
      'HEAD',
      null,
      null,
      1,
      'review_ready',
      null,
      null,
      null,
      '2026-03-30T00:00:00.000Z',
      '2026-03-30T00:00:00.000Z',
    );
  legacyDb
    .prepare(
      `INSERT INTO paired_task_execution_leases (
        task_id,
        chat_jid,
        role,
        intent_kind,
        claimed_run_id,
        task_status,
        task_updated_at,
        claimed_at,
        updated_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.taskId,
      'group@test',
      args.role ?? 'reviewer',
      args.intentKind ?? 'reviewer-turn',
      args.claimedRunId ?? `legacy-run-${args.role ?? 'reviewer'}`,
      args.taskStatus ?? 'review_ready',
      '2026-03-30T00:00:00.000Z',
      '2026-03-30T00:00:00.000Z',
      '2026-03-30T00:00:00.000Z',
      '2099-03-30T00:10:00.000Z',
    );
  legacyDb.close();
}

describe('paired follow-up scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    resetPairedFollowUpScheduleState();
    vi.useRealTimers();
  });

  it('deduplicates the same follow-up intent while task state is unchanged', () => {
    const enqueue = vi.fn();
    const task = {
      id: 'task-1',
      status: 'review_ready',
      round_trip_count: 1,
      updated_at: '2026-03-30T00:00:00.000Z',
    } as const;

    const first = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task,
      intentKind: 'reviewer-turn',
      enqueue,
    });
    const second = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task,
      intentKind: 'reviewer-turn',
      enqueue,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('deduplicates the same follow-up intent across different runs', () => {
    const enqueue = vi.fn();
    const task = {
      id: 'task-1',
      status: 'review_ready',
      round_trip_count: 1,
      updated_at: '2026-03-30T00:00:00.000Z',
    } as const;

    const first = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task,
      intentKind: 'reviewer-turn',
      enqueue,
    });
    const second = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-2',
      task,
      intentKind: 'reviewer-turn',
      enqueue,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('persists the same logical turn id across reservation and execution lease rows', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-paired-turn-id-'),
    );
    const dbPath = path.join(tempDir, 'paired-state.db');

    try {
      const emptyDb = new Database(dbPath);
      emptyDb.close();
      _initTestDatabaseFromFile(dbPath);
      resetPairedFollowUpScheduleState();

      const task = {
        id: 'task-turn-id-persistence',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'claude',
        reviewer_service_id: 'codex-main',
        owner_agent_type: 'claude-code',
        reviewer_agent_type: 'codex',
        arbiter_agent_type: null,
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        review_requested_at: null,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-04-10T00:00:00.000Z',
        status: 'review_ready',
        round_trip_count: 1,
        updated_at: '2026-04-10T00:00:00.000Z',
      } as const;
      createPairedTask(task as any);

      expect(
        schedulePairedFollowUpOnce({
          chatJid: task.chat_jid,
          runId: 'run-turn-id-reservation',
          task,
          intentKind: 'reviewer-turn',
          enqueue: vi.fn(),
        }),
      ).toBe(true);
      expect(
        claimPairedTurnExecution({
          chatJid: task.chat_jid,
          runId: 'run-turn-id-claim',
          task,
          intentKind: 'reviewer-turn',
        }),
      ).toBe(true);

      const rawDatabase = new Database(dbPath, { readonly: true });
      const reservationRow = rawDatabase
        .prepare(
          `
            SELECT turn_id, turn_attempt_no, turn_role
              FROM paired_turn_reservations
             WHERE task_id = ?
               AND intent_kind = ?
          `,
        )
        .get(task.id, 'reviewer-turn') as
        | { turn_id: string; turn_attempt_no: number | null; turn_role: string }
        | undefined;
      const leaseRow = rawDatabase
        .prepare(
          `
            SELECT turn_id, turn_attempt_no, role
              FROM paired_task_execution_leases
             WHERE task_id = ?
          `,
        )
        .get(task.id) as
        | { turn_id: string; turn_attempt_no: number | null; role: string }
        | undefined;
      const turnRow = rawDatabase
        .prepare(
          `
            SELECT turn_id, task_id, task_updated_at, role, intent_kind
              FROM paired_turns
             WHERE task_id = ?
          `,
        )
        .get(task.id) as
        | {
            turn_id: string;
            task_id: string;
            task_updated_at: string;
            role: string;
            intent_kind: string;
          }
        | undefined;
      rawDatabase.close();

      expect(reservationRow).toEqual({
        turn_id:
          'task-turn-id-persistence:2026-04-10T00:00:00.000Z:reviewer-turn',
        turn_attempt_no: 1,
        turn_role: 'reviewer',
      });
      expect(leaseRow).toEqual({
        turn_id:
          'task-turn-id-persistence:2026-04-10T00:00:00.000Z:reviewer-turn',
        turn_attempt_no: 1,
        role: 'reviewer',
      });
      expect(turnRow).toEqual({
        turn_id:
          'task-turn-id-persistence:2026-04-10T00:00:00.000Z:reviewer-turn',
        task_id: task.id,
        task_updated_at: task.updated_at,
        role: 'reviewer',
        intent_kind: 'reviewer-turn',
      });
      expect(
        getPairedTurnById(
          'task-turn-id-persistence:2026-04-10T00:00:00.000Z:reviewer-turn',
        ),
      ).toMatchObject({
        turn_id:
          'task-turn-id-persistence:2026-04-10T00:00:00.000Z:reviewer-turn',
        state: 'running',
        executor_service_id: CURRENT_SERVICE_ID,
        attempt_no: 1,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
      resetPairedFollowUpScheduleState();
    }
  });
  it('keeps different round trips schedulable', () => {
    const enqueue = vi.fn();

    const first = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task: {
        id: 'task-1',
        status: 'review_ready',
        round_trip_count: 1,
        updated_at: '2026-03-30T00:00:00.000Z',
      } as const,
      intentKind: 'reviewer-turn',
      enqueue,
    });
    const second = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task: {
        id: 'task-1',
        status: 'review_ready',
        round_trip_count: 2,
        updated_at: '2026-03-30T00:00:01.000Z',
      } as const,
      intentKind: 'reviewer-turn',
      enqueue,
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('builds a key that includes round trip count and intent', () => {
    expect(
      buildPairedFollowUpKey({
        taskId: 'task-1',
        taskStatus: 'review_ready',
        roundTripCount: 3,
        taskUpdatedAt: '2026-03-30T00:00:00.000Z',
        intentKind: 'reviewer-turn',
      }),
    ).toBe('task-1:review_ready:3:2026-03-30T00:00:00.000Z:reviewer-turn');
  });

  it('keeps different task revisions schedulable even when status and round trip are unchanged', () => {
    const enqueue = vi.fn();

    const first = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-1',
      task: {
        id: 'task-1',
        status: 'active',
        round_trip_count: 1,
        updated_at: '2026-03-30T00:00:00.000Z',
      } as const,
      intentKind: 'owner-follow-up',
      enqueue,
    });
    const second = schedulePairedFollowUpOnce({
      chatJid: 'group@test',
      runId: 'run-2',
      task: {
        id: 'task-1',
        status: 'active',
        round_trip_count: 1,
        updated_at: '2026-03-30T00:00:10.000Z',
      } as const,
      intentKind: 'owner-follow-up',
      enqueue,
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('does not create a fresh reviewer handoff identity after a pure claim leaves the semantic task revision unchanged', () => {
    const enqueue = vi.fn();
    const task = {
      id: 'task-semantic-reviewer-handoff',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      status: 'review_ready',
      round_trip_count: 1,
      updated_at: '2026-03-30T00:00:00.000Z',
    } as const;
    createPairedTask(task as any);

    expect(
      schedulePairedFollowUpOnce({
        chatJid: task.chat_jid,
        runId: 'run-reviewer-schedule-1',
        task,
        intentKind: 'reviewer-turn',
        enqueue,
      }),
    ).toBe(true);
    expect(
      claimPairedTurnExecution({
        chatJid: task.chat_jid,
        runId: 'run-reviewer-claim-1',
        task,
        intentKind: 'reviewer-turn',
      }),
    ).toBe(true);

    const freshRefetch = getPairedTaskById(task.id);
    expect(freshRefetch?.updated_at).toBe(task.updated_at);
    expect(
      schedulePairedFollowUpOnce({
        chatJid: task.chat_jid,
        runId: 'run-reviewer-schedule-2',
        task: freshRefetch ?? task,
        intentKind: 'reviewer-turn',
        enqueue,
      }),
    ).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('requeues the same reviewer logical turn after a failed fallback handoff', () => {
    const firstEnqueue = vi.fn();
    const secondEnqueue = vi.fn();
    const currentReviewerServiceId =
      CURRENT_AGENT_TYPE === 'codex'
        ? CODEX_REVIEW_SERVICE_ID
        : CLAUDE_SERVICE_ID;
    const otherReviewerServiceId =
      OTHER_AGENT_TYPE === 'codex'
        ? CODEX_REVIEW_SERVICE_ID
        : CLAUDE_SERVICE_ID;
    const task = {
      id: 'task-reviewer-handoff-retry',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: CURRENT_SERVICE_ID,
      reviewer_service_id: OTHER_SERVICE_ID,
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-04-10T00:00:00.000Z',
      status: 'review_ready',
      round_trip_count: 1,
      updated_at: '2026-04-10T00:00:00.000Z',
    } as const;
    createPairedTask(task as any);

    expect(
      schedulePairedFollowUpOnce({
        chatJid: task.chat_jid,
        runId: 'run-reviewer-schedule-1',
        task,
        intentKind: 'reviewer-turn',
        enqueue: firstEnqueue,
      }),
    ).toBe(true);
    expect(
      claimPairedTurnExecution({
        chatJid: task.chat_jid,
        runId: 'run-reviewer-claim-1',
        task,
        intentKind: 'reviewer-turn',
      }),
    ).toBe(true);

    const handoff = createServiceHandoff({
      chat_jid: task.chat_jid,
      group_folder: task.group_folder,
      paired_task_id: task.id,
      paired_task_updated_at: task.updated_at,
      turn_intent_kind: 'reviewer-turn',
      turn_role: 'reviewer',
      source_service_id: currentReviewerServiceId,
      target_service_id: otherReviewerServiceId,
      source_role: 'reviewer',
      target_role: 'reviewer',
      source_agent_type: CURRENT_AGENT_TYPE,
      target_agent_type: OTHER_AGENT_TYPE,
      prompt: 'review retry after fallback',
      intended_role: 'reviewer',
    });

    failServiceHandoff(handoff.id, 'fallback handoff failed');
    releasePairedTaskExecutionLease({
      taskId: task.id,
      runId: 'run-reviewer-claim-1',
    });

    expect(
      getPairedTurnById(
        'task-reviewer-handoff-retry:2026-04-10T00:00:00.000Z:reviewer-turn',
      ),
    ).toMatchObject({
      state: 'failed',
      attempt_no: 1,
      last_error: 'fallback handoff failed',
    });

    expect(
      schedulePairedFollowUpOnce({
        chatJid: task.chat_jid,
        runId: 'run-reviewer-schedule-2',
        task,
        intentKind: 'reviewer-turn',
        enqueue: secondEnqueue,
      }),
    ).toBe(true);
    expect(secondEnqueue).toHaveBeenCalledTimes(1);
    expect(
      getPairedTurnById(
        'task-reviewer-handoff-retry:2026-04-10T00:00:00.000Z:reviewer-turn',
      ),
    ).toMatchObject({
      state: 'failed',
      attempt_no: 1,
      last_error: 'fallback handoff failed',
    });
    expect(
      getPairedTurnAttempts(
        'task-reviewer-handoff-retry:2026-04-10T00:00:00.000Z:reviewer-turn',
      ),
    ).toMatchObject([
      {
        attempt_no: 1,
        state: 'failed',
        last_error: 'fallback handoff failed',
      },
    ]);

    expect(
      claimPairedTurnExecution({
        chatJid: task.chat_jid,
        runId: 'run-reviewer-claim-2',
        task,
        intentKind: 'reviewer-turn',
      }),
    ).toBe(true);
    expect(
      getPairedTurnById(
        'task-reviewer-handoff-retry:2026-04-10T00:00:00.000Z:reviewer-turn',
      ),
    ).toMatchObject({
      state: 'running',
      attempt_no: 2,
    });
  });

  it('blocks a fresh-refetched task revision from reclaiming the same turn while the execution lease is active', () => {
    const task = {
      id: 'task-1',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      status: 'review_ready',
      round_trip_count: 1,
      updated_at: '2026-03-30T00:00:00.000Z',
    } as const;
    createPairedTask(task as any);

    const first = claimPairedTurnExecution({
      chatJid: 'group@test',
      runId: 'run-1',
      task,
      intentKind: 'reviewer-turn',
    });
    const freshRefetch = getPairedTaskById(task.id);
    const second = claimPairedTurnExecution({
      chatJid: 'group@test',
      runId: 'run-2',
      task: freshRefetch ?? task,
      intentKind: 'reviewer-turn',
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(getPairedTaskById(task.id)?.updated_at).toBe(task.updated_at);
  });

  it('reclaims an expired execution lease after restart while blocking fresh claims before expiry', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-paired-lease-'),
    );
    const dbPath = path.join(tempDir, 'paired-state.db');

    try {
      _initTestDatabaseFromFile(dbPath);
      resetPairedFollowUpScheduleState();

      const task = {
        id: 'task-restart-lease',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'claude',
        reviewer_service_id: 'codex-main',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        review_requested_at: null,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-03-30T00:00:00.000Z',
        status: 'review_ready',
        round_trip_count: 1,
        updated_at: '2026-03-30T00:00:00.000Z',
      } as const;
      createPairedTask(task as any);

      const first = claimPairedTurnExecution({
        chatJid: task.chat_jid,
        runId: 'run-first-reviewer',
        task,
        intentKind: 'reviewer-turn',
      });
      expect(first).toBe(true);

      const rawDatabase = new Database(dbPath);
      rawDatabase
        .prepare(
          `
            UPDATE paired_task_execution_leases
               SET claimed_service_id = ?
             WHERE task_id = ?
          `,
        )
        .run('other-service', task.id);
      rawDatabase.close();

      _initTestDatabaseFromFile(dbPath);
      const crossServiceTask = getPairedTaskById(task.id);
      expect(crossServiceTask).toBeDefined();
      expect(
        claimPairedTurnExecution({
          chatJid: task.chat_jid,
          runId: 'run-before-expiry-reviewer',
          task: crossServiceTask ?? task,
          intentKind: 'reviewer-turn',
        }),
      ).toBe(false);
      expect(
        claimPairedTurnExecution({
          chatJid: task.chat_jid,
          runId: 'run-before-expiry-owner',
          task: crossServiceTask ?? task,
          intentKind: 'owner-turn',
        }),
      ).toBe(false);

      const expiryDatabase = new Database(dbPath);
      expiryDatabase
        .prepare(
          `
            UPDATE paired_task_execution_leases
               SET updated_at = ?,
                   expires_at = ?
             WHERE task_id = ?
          `,
        )
        .run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', task.id);
      expiryDatabase.close();

      _initTestDatabaseFromFile(dbPath);
      const recoveredTask = getPairedTaskById(task.id);
      expect(recoveredTask).toBeDefined();
      expect(
        claimPairedTurnExecution({
          chatJid: task.chat_jid,
          runId: 'run-after-expiry-reviewer',
          task: recoveredTask ?? task,
          intentKind: 'reviewer-turn',
        }),
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
      resetPairedFollowUpScheduleState();
    }
  });

  it('clears same-service legacy execution leases during startup so an interrupted turn can be reclaimed immediately after restart', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-paired-lease-startup-'),
    );
    const dbPath = path.join(tempDir, 'paired-state.db');

    try {
      createLegacyLeaseDatabase({
        dbPath,
        taskId: 'task-restart-cleanup',
        reviewerServiceId: CURRENT_SERVICE_ID,
        reviewerAgentType: CURRENT_AGENT_TYPE,
      });
      resetPairedFollowUpScheduleState();

      _initTestDatabaseFromFile(dbPath);
      const migratedDb = new Database(dbPath, { readonly: true });
      const leaseCount = (
        migratedDb
          .prepare(
            'SELECT COUNT(*) AS count FROM paired_task_execution_leases WHERE task_id = ?',
          )
          .get('task-restart-cleanup') as { count: number }
      ).count;
      migratedDb.close();

      expect(leaseCount).toBe(0);

      const recoveredTask = getPairedTaskById('task-restart-cleanup');
      expect(recoveredTask).toBeDefined();
      expect(
        claimPairedTurnExecution({
          chatJid: 'group@test',
          runId: 'run-after-restart',
          task: recoveredTask!,
          intentKind: 'reviewer-turn',
        }),
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
      resetPairedFollowUpScheduleState();
    }
  });

  it('creates attempt 2 after restart reclaim without overwriting attempt 1', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-paired-attempt-restart-'),
    );
    const dbPath = path.join(tempDir, 'paired-state.db');

    try {
      _initTestDatabaseFromFile(dbPath);
      resetPairedFollowUpScheduleState();

      const task = {
        id: 'task-restart-attempt-history',
        chat_jid: 'group@test',
        group_folder: 'test-group',
        owner_service_id: 'claude',
        reviewer_service_id: 'codex-main',
        title: null,
        source_ref: 'HEAD',
        plan_notes: null,
        review_requested_at: null,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
        created_at: '2026-03-30T00:00:00.000Z',
        status: 'review_ready',
        round_trip_count: 1,
        updated_at: '2026-03-30T00:00:00.000Z',
      } as const;
      createPairedTask(task as any);

      expect(
        claimPairedTurnExecution({
          chatJid: task.chat_jid,
          runId: 'run-restart-attempt-1',
          task,
          intentKind: 'reviewer-turn',
        }),
      ).toBe(true);

      _initTestDatabaseFromFile(dbPath);
      const recoveredTask = getPairedTaskById(task.id);
      expect(recoveredTask).toBeDefined();

      expect(
        claimPairedTurnExecution({
          chatJid: task.chat_jid,
          runId: 'run-restart-attempt-2',
          task: recoveredTask ?? task,
          intentKind: 'reviewer-turn',
        }),
      ).toBe(true);

      expect(
        getPairedTurnById(
          'task-restart-attempt-history:2026-03-30T00:00:00.000Z:reviewer-turn',
        ),
      ).toMatchObject({
        state: 'running',
        attempt_no: 2,
      });
      expect(
        getPairedTurnAttempts(
          'task-restart-attempt-history:2026-03-30T00:00:00.000Z:reviewer-turn',
        ),
      ).toMatchObject([
        {
          attempt_no: 1,
          state: 'cancelled',
          executor_service_id: CURRENT_SERVICE_ID,
          executor_agent_type: CURRENT_AGENT_TYPE,
        },
        {
          attempt_no: 2,
          state: 'running',
          executor_service_id: CURRENT_SERVICE_ID,
          executor_agent_type: CURRENT_AGENT_TYPE,
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
      resetPairedFollowUpScheduleState();
    }
  });

  it('preserves legacy execution leases that belong to another service during startup cleanup', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-paired-lease-preserve-'),
    );
    const dbPath = path.join(tempDir, 'paired-state.db');

    try {
      createLegacyLeaseDatabase({
        dbPath,
        taskId: 'task-cross-service-legacy-lease',
        reviewerServiceId: OTHER_SERVICE_ID,
        reviewerAgentType: OTHER_AGENT_TYPE,
      });
      resetPairedFollowUpScheduleState();

      _initTestDatabaseFromFile(dbPath);

      const migratedDb = new Database(dbPath, { readonly: true });
      const leaseRow = migratedDb
        .prepare(
          `
            SELECT claimed_service_id
              FROM paired_task_execution_leases
             WHERE task_id = ?
          `,
        )
        .get('task-cross-service-legacy-lease') as
        | { claimed_service_id: string | null }
        | undefined;
      migratedDb.close();

      expect(leaseRow).toEqual({
        claimed_service_id: OTHER_SERVICE_ID,
      });

      const task = getPairedTaskById('task-cross-service-legacy-lease');
      expect(task).toBeDefined();
      expect(
        claimPairedTurnExecution({
          chatJid: 'group@test',
          runId: 'run-cross-service-reclaim',
          task: task!,
          intentKind: 'reviewer-turn',
        }),
      ).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
      resetPairedFollowUpScheduleState();
    }
  });

  it('preserves the raw runtime service id for legacy owner leases instead of canonicalizing to the owner shadow', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-paired-lease-owner-failover-'),
    );
    const dbPath = path.join(tempDir, 'paired-state.db');

    try {
      createLegacyLeaseDatabase({
        dbPath,
        taskId: 'task-owner-failover-legacy-lease',
        role: 'owner',
        intentKind: 'owner-turn',
        taskStatus: 'active',
        ownerServiceId: CODEX_REVIEW_SERVICE_ID,
        ownerAgentType: 'codex',
        reviewerServiceId: CLAUDE_SERVICE_ID,
        reviewerAgentType: 'claude-code',
      });
      resetPairedFollowUpScheduleState();

      _initTestDatabaseFromFile(dbPath);

      const migratedDb = new Database(dbPath, { readonly: true });
      const leaseRow = migratedDb
        .prepare(
          `
            SELECT claimed_service_id
              FROM paired_task_execution_leases
             WHERE task_id = ?
          `,
        )
        .get('task-owner-failover-legacy-lease') as
        | { claimed_service_id: string | null }
        | undefined;
      migratedDb.close();

      expect(leaseRow).toEqual({
        claimed_service_id: CODEX_REVIEW_SERVICE_ID,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
      resetPairedFollowUpScheduleState();
    }
  });
});
