import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createPairedTask,
  getPairedTurnAttempts,
  markPairedTurnRunning,
  recoverInterruptedPairedTurnAttemptsForService,
} from './db.js';
import { CLAUDE_SERVICE_ID, CODEX_MAIN_SERVICE_ID } from './config.js';
import { requireDatabase } from './db/runtime-database.js';
import { buildPairedTurnIdentity } from './paired-turn-identity.js';
import type { PairedTask } from './types.js';

function makeTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'restart-running-attempt-task',
    chat_jid: 'dc:restart-room',
    group_folder: 'restart-room',
    owner_service_id: CODEX_MAIN_SERVICE_ID,
    reviewer_service_id: 'claude',
    owner_agent_type: 'codex',
    reviewer_agent_type: 'claude-code',
    arbiter_agent_type: null,
    title: null,
    source_ref: 'HEAD',
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 1,
    owner_failure_count: 0,
    owner_step_done_streak: 0,
    finalize_step_done_count: 0,
    task_done_then_user_reopen_count: 0,
    empty_step_done_streak: 0,
    status: 'active',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-05-27T00:00:00.000Z',
    updated_at: '2026-05-27T00:10:00.000Z',
    ...overrides,
  };
}

describe('paired turn attempt restart recovery', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('fails local-service running attempts so restart recovery can retry the turn', () => {
    const task = makeTask();
    createPairedTask(task);
    const turnIdentity = buildPairedTurnIdentity({
      taskId: task.id,
      taskUpdatedAt: task.updated_at,
      intentKind: 'owner-turn',
      role: 'owner',
    });

    markPairedTurnRunning({
      turnIdentity,
      executorServiceId: CODEX_MAIN_SERVICE_ID,
      executorAgentType: 'codex',
      runId: 'run-before-restart',
    });

    const recovered = recoverInterruptedPairedTurnAttemptsForService({
      serviceIds: [CLAUDE_SERVICE_ID, CODEX_MAIN_SERVICE_ID],
      now: '2026-05-27T00:11:00.000Z',
    });

    expect(recovered).toEqual([
      expect.objectContaining({
        chat_jid: task.chat_jid,
        group_folder: task.group_folder,
        task_id: task.id,
        task_status: 'active',
        turn_id: turnIdentity.turnId,
        attempt_no: 1,
        role: 'owner',
        intent_kind: 'owner-turn',
      }),
    ]);
    expect(getPairedTurnAttempts(turnIdentity.turnId)).toEqual([
      expect.objectContaining({
        attempt_no: 1,
        state: 'failed',
        active_run_id: null,
        completed_at: '2026-05-27T00:11:00.000Z',
        last_error: 'Interrupted by service restart before completion.',
      }),
    ]);

    markPairedTurnRunning({
      turnIdentity,
      executorServiceId: CODEX_MAIN_SERVICE_ID,
      executorAgentType: 'codex',
      runId: 'run-after-restart',
    });

    expect(getPairedTurnAttempts(turnIdentity.turnId)).toEqual([
      expect.objectContaining({
        attempt_no: 1,
        state: 'failed',
      }),
      expect.objectContaining({
        attempt_no: 2,
        parent_attempt_id: `${turnIdentity.turnId}:attempt:1`,
        state: 'running',
        active_run_id: 'run-after-restart',
      }),
    ]);
  });

  it('does not touch running attempts owned by another service', () => {
    const task = makeTask({ id: 'other-service-task' });
    createPairedTask(task);
    const turnIdentity = buildPairedTurnIdentity({
      taskId: task.id,
      taskUpdatedAt: task.updated_at,
      intentKind: 'reviewer-turn',
      role: 'reviewer',
    });

    markPairedTurnRunning({
      turnIdentity,
      executorServiceId: 'claude',
      executorAgentType: 'claude-code',
      runId: 'reviewer-run',
    });

    expect(
      recoverInterruptedPairedTurnAttemptsForService({
        serviceIds: [CODEX_MAIN_SERVICE_ID],
        now: '2026-05-27T00:11:00.000Z',
      }),
    ).toEqual([]);
    expect(getPairedTurnAttempts(turnIdentity.turnId)).toEqual([
      expect.objectContaining({
        state: 'running',
        active_run_id: 'reviewer-run',
      }),
    ]);
  });

  it('recovers codex executor attempts even when the orchestration lease used the claude service id', () => {
    const task = makeTask({ id: 'cross-service-lease-task' });
    createPairedTask(task);
    const turnIdentity = buildPairedTurnIdentity({
      taskId: task.id,
      taskUpdatedAt: task.updated_at,
      intentKind: 'owner-turn',
      role: 'owner',
    });

    markPairedTurnRunning({
      turnIdentity,
      executorServiceId: CODEX_MAIN_SERVICE_ID,
      executorAgentType: 'codex',
      runId: 'codex-run-before-restart',
    });
    requireDatabase()
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
        task.id,
        task.chat_jid,
        'owner',
        turnIdentity.turnId,
        `${turnIdentity.turnId}:attempt:1`,
        1,
        'owner-turn',
        'orchestrator-run-before-restart',
        CLAUDE_SERVICE_ID,
        task.status,
        task.updated_at,
        '2026-05-27T00:10:00.000Z',
        '2026-05-27T00:10:00.000Z',
        '2026-05-27T00:20:00.000Z',
      );

    expect(
      recoverInterruptedPairedTurnAttemptsForService({
        serviceIds: [CLAUDE_SERVICE_ID, CODEX_MAIN_SERVICE_ID],
        now: '2026-05-27T00:11:00.000Z',
      }),
    ).toEqual([
      expect.objectContaining({
        task_id: task.id,
        turn_id: turnIdentity.turnId,
        role: 'owner',
        intent_kind: 'owner-turn',
      }),
    ]);
    expect(getPairedTurnAttempts(turnIdentity.turnId)).toEqual([
      expect.objectContaining({
        state: 'failed',
        active_run_id: null,
      }),
    ]);
  });
});
