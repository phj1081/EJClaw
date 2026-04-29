import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createPairedTask,
  failPairedTurn,
  getOwnerCodexBadRequestFailureSummaryForTask,
  markPairedTurnRunning,
} from './db.js';
import { CODEX_MAIN_SERVICE_ID } from './config.js';
import { buildPairedTurnIdentity } from './paired-turn-identity.js';
import type { PairedTask } from './types.js';

const BAD_REQUEST_ERROR = '{"detail":"Bad Request"}';

beforeEach(() => {
  _initTestDatabase();
});

function makeTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'task-bad-request',
    chat_jid: 'dc:room',
    group_folder: 'eyejokerdb-9',
    owner_service_id: CODEX_MAIN_SERVICE_ID,
    reviewer_service_id: 'claude',
    title: null,
    source_ref: null,
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 1,
    status: 'active',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-04-29T08:00:00.000Z',
    updated_at: '2026-04-29T08:00:00.000Z',
    ...overrides,
  };
}

function recordOwnerCodexFailure(args: {
  taskId: string;
  taskUpdatedAt: string;
  runId: string;
  error: string;
}): void {
  const turnIdentity = buildPairedTurnIdentity({
    taskId: args.taskId,
    taskUpdatedAt: args.taskUpdatedAt,
    intentKind: 'owner-follow-up',
    role: 'owner',
  });

  markPairedTurnRunning({
    turnIdentity,
    executorServiceId: CODEX_MAIN_SERVICE_ID,
    executorAgentType: 'codex',
    runId: args.runId,
  });
  failPairedTurn({ turnIdentity, error: args.error });
}

describe('owner Codex Bad Request attempt summaries', () => {
  it('summarizes consecutive owner Codex Bad Request failures for a task', () => {
    const task = makeTask();
    createPairedTask(task);

    for (const runId of ['run-1', 'run-2', 'run-3']) {
      recordOwnerCodexFailure({
        taskId: task.id,
        taskUpdatedAt: task.updated_at,
        runId,
        error: BAD_REQUEST_ERROR,
      });
    }

    expect(
      getOwnerCodexBadRequestFailureSummaryForTask({
        taskId: task.id,
        threshold: 3,
      }),
    ).toMatchObject({
      taskId: task.id,
      failures: 3,
    });
  });

  it('does not summarize when the latest owner Codex failures are not all the narrow Bad Request signal', () => {
    const task = makeTask();
    createPairedTask(task);

    recordOwnerCodexFailure({
      taskId: task.id,
      taskUpdatedAt: task.updated_at,
      runId: 'run-1',
      error: BAD_REQUEST_ERROR,
    });
    recordOwnerCodexFailure({
      taskId: task.id,
      taskUpdatedAt: task.updated_at,
      runId: 'run-2',
      error: BAD_REQUEST_ERROR,
    });
    recordOwnerCodexFailure({
      taskId: task.id,
      taskUpdatedAt: task.updated_at,
      runId: 'run-3',
      error: 'HTTP 400 Bad Request',
    });

    expect(
      getOwnerCodexBadRequestFailureSummaryForTask({
        taskId: task.id,
        threshold: 3,
      }),
    ).toBeNull();
  });

  it('counts only the latest consecutive Bad Request failures', () => {
    const task = makeTask();
    createPairedTask(task);

    recordOwnerCodexFailure({
      taskId: task.id,
      taskUpdatedAt: task.updated_at,
      runId: 'run-1',
      error: BAD_REQUEST_ERROR,
    });
    recordOwnerCodexFailure({
      taskId: task.id,
      taskUpdatedAt: task.updated_at,
      runId: 'run-2',
      error: 'HTTP 400 Bad Request',
    });
    for (const runId of ['run-3', 'run-4', 'run-5']) {
      recordOwnerCodexFailure({
        taskId: task.id,
        taskUpdatedAt: task.updated_at,
        runId,
        error: BAD_REQUEST_ERROR,
      });
    }

    expect(
      getOwnerCodexBadRequestFailureSummaryForTask({
        taskId: task.id,
        threshold: 3,
      }),
    ).toMatchObject({
      taskId: task.id,
      failures: 3,
    });
  });
});
