import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createPairedTask,
  getPairedTurnAttempts,
  markPairedTurnRunning,
  recoverInterruptedPairedTurnAttemptsForService,
} from './db.js';
import { CODEX_MAIN_SERVICE_ID } from './config.js';
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

  it('fails same-service running attempts so restart recovery can retry the turn', () => {
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
      serviceId: CODEX_MAIN_SERVICE_ID,
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
        serviceId: CODEX_MAIN_SERVICE_ID,
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
});
