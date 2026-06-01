import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => {
  const updatePairedTask = vi.fn();
  return {
    getPairedTaskById: vi.fn(),
    getPairedWorkspace: vi.fn(),
    updatePairedTask,
    updatePairedTaskIfUnchanged: vi.fn((id, _expectedUpdatedAt, updates) => {
      updatePairedTask(id, updates);
      return true;
    }),
    releasePairedTaskExecutionLease: vi.fn(),
  };
});

vi.mock('./paired-workspace-manager.js', () => ({
  isOwnerWorkspaceRepairNeededError: vi.fn(() => false),
  markPairedTaskReviewReady: vi.fn(),
  prepareReviewerWorkspaceForExecution: vi.fn(),
  provisionOwnerWorkspaceForPairedTask: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import * as config from './config.js';
import * as db from './db.js';
import { completePairedExecutionContext } from './paired-execution-context.js';
import type { PairedTask } from './types.js';

function buildPairedTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'task-1',
    chat_jid: 'dc:test',
    group_folder: 'ejclaw',
    owner_service_id: config.CODEX_MAIN_SERVICE_ID,
    reviewer_service_id: config.REVIEWER_SERVICE_ID_FOR_TYPE,
    title: null,
    source_ref: 'HEAD',
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 0,
    owner_failure_count: 0,
    owner_step_done_streak: 0,
    finalize_step_done_count: 0,
    task_done_then_user_reopen_count: 0,
    empty_step_done_streak: 0,
    status: 'active',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-03-28T00:00:00.000Z',
    updated_at: '2026-03-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('paired execution routing loop guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.getPairedWorkspace).mockReturnValue(undefined);
  });

  it('clears stale owner loop state when reviewer approves normally', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_review',
        source_ref: 'approved-ref',
        owner_failure_count: 1,
        owner_step_done_streak: 3,
        finalize_step_done_count: 1,
        empty_step_done_streak: 2,
        arbiter_verdict: 'proceed',
        arbiter_requested_at: '2026-03-28T00:00:01.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'reviewer',
      status: 'succeeded',
      summary: 'TASK_DONE\n승인',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'merge_ready',
        source_ref: 'approved-ref',
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        finalize_step_done_count: 0,
        empty_step_done_streak: 0,
        arbiter_verdict: null,
        arbiter_requested_at: null,
      }),
    );
  });

  it('clears stale owner loop state when reviewer approval is recovered from a failed run', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_review',
        source_ref: 'approved-ref',
        owner_step_done_streak: 2,
        empty_step_done_streak: 2,
        arbiter_verdict: 'proceed',
        arbiter_requested_at: '2026-03-28T00:00:01.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'reviewer',
      status: 'failed',
      summary: 'DONE\n승인',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'merge_ready',
        owner_step_done_streak: 0,
        empty_step_done_streak: 0,
        arbiter_verdict: null,
        arbiter_requested_at: null,
      }),
    );
  });

  it('routes arbiter PROCEED back to reviewer instead of owner ping-pong', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_arbitration',
        round_trip_count: config.ARBITER_DEADLOCK_THRESHOLD,
        owner_step_done_streak: 3,
        finalize_step_done_count: 1,
        empty_step_done_streak: 4,
        arbiter_requested_at: '2026-03-28T00:00:01.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'arbiter',
      status: 'succeeded',
      summary: 'PROCEED\nReviewer should approve.',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'review_ready',
        round_trip_count: 0,
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        finalize_step_done_count: 0,
        empty_step_done_streak: 0,
        arbiter_verdict: 'proceed',
        arbiter_requested_at: null,
      }),
    );
  });

  it('escalates unknown arbiter verdicts instead of treating them as approval', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_arbitration',
        round_trip_count: config.ARBITER_DEADLOCK_THRESHOLD,
        owner_step_done_streak: 3,
        empty_step_done_streak: 4,
        arbiter_requested_at: '2026-03-28T00:00:01.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'arbiter',
      status: 'succeeded',
      summary: 'No formal verdict, but this should not re-run owner.',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'completed',
        arbiter_verdict: 'unknown',
        completion_reason: 'arbiter_escalated',
      }),
    );
  });

  it('does not re-arm arbiter loop after terminal Codex account failure', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_arbitration',
        updated_at: '2026-03-28T00:00:05.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'arbiter',
      status: 'failed',
      summary:
        'auth-expired: All Codex rotation accounts unavailable; re-auth required before launching Codex\nExecution completed without a visible terminal verdict.',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'completed',
        arbiter_verdict: 'escalate',
        arbiter_requested_at: null,
        completion_reason: 'arbiter_codex_unavailable',
      }),
    );
  });

  it('completes reviewer task after terminal Codex account failure instead of preserving review_ready loop', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_review',
        updated_at: '2026-03-28T00:00:05.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'reviewer',
      status: 'failed',
      summary:
        'auth-expired: All Codex rotation accounts unavailable; re-auth required before launching Codex\nExecution completed without a visible terminal verdict.',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'completed',
        arbiter_verdict: 'escalate',
        arbiter_requested_at: null,
        completion_reason: 'reviewer_codex_unavailable',
      }),
    );
  });

  it('completes owner task after terminal Codex account failure instead of retrying owner forever', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'active',
        updated_at: '2026-03-28T00:00:05.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'failed',
      summary:
        'auth-expired: All Codex rotation accounts unavailable; re-auth required before launching Codex\nExecution completed without a visible terminal verdict.',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'completed',
        arbiter_verdict: 'escalate',
        arbiter_requested_at: null,
        completion_reason: 'owner_codex_unavailable',
      }),
    );
  });

  it('keeps arbiter REVISE on owner flow while clearing stale loop counters', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_arbitration',
        round_trip_count: config.ARBITER_DEADLOCK_THRESHOLD,
        owner_step_done_streak: 3,
        empty_step_done_streak: 4,
        arbiter_requested_at: '2026-03-28T00:00:01.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'arbiter',
      status: 'succeeded',
      summary: 'REVISE\nOwner must fix this.',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'active',
        owner_step_done_streak: 0,
        empty_step_done_streak: 0,
        arbiter_verdict: 'revise',
        arbiter_requested_at: null,
      }),
    );
  });
});
