import { Database } from 'bun:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  _initTestDatabaseFromFile,
  createPairedTask,
  getPairedTaskById,
} from './db.js';
import {
  buildPairedFollowUpKey,
  claimPairedTurnExecution,
  resetPairedFollowUpScheduleState,
  schedulePairedFollowUpOnce,
} from './paired-follow-up-scheduler.js';

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

    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(second).toBeNull();
    expect(getPairedTaskById(task.id)?.updated_at).toBe(first);
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
      expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      _initTestDatabaseFromFile(dbPath);
      const freshTask = getPairedTaskById(task.id);
      expect(freshTask).toBeDefined();
      expect(
        claimPairedTurnExecution({
          chatJid: task.chat_jid,
          runId: 'run-before-expiry-reviewer',
          task: freshTask ?? task,
          intentKind: 'reviewer-turn',
        }),
      ).toBeNull();
      expect(
        claimPairedTurnExecution({
          chatJid: task.chat_jid,
          runId: 'run-before-expiry-owner',
          task: freshTask ?? task,
          intentKind: 'owner-turn',
        }),
      ).toBeNull();

      const rawDatabase = new Database(dbPath);
      rawDatabase
        .prepare(
          `
            UPDATE paired_task_execution_leases
               SET updated_at = ?,
                   expires_at = ?
             WHERE task_id = ?
          `,
        )
        .run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', task.id);
      rawDatabase.close();

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
      ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      _initTestDatabase();
      resetPairedFollowUpScheduleState();
    }
  });
});
