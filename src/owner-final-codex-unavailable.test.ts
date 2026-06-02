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
import { resolvePairedFollowUpQueueAction } from './message-agent-executor-rules.js';
import type { PairedTask } from './types.js';

const CODEX_UNAVAILABLE_SUMMARY =
  'auth-expired: All Codex rotation accounts unavailable; re-auth required before launching Codex\nExecution completed without a visible terminal verdict.';

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
    status: 'merge_ready',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-03-28T00:00:00.000Z',
    updated_at: '2026-03-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('owner final Codex unavailable handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.getPairedWorkspace).mockReturnValue(undefined);
    vi.spyOn(config, 'isArbiterEnabled').mockReturnValue(true);
  });

  it('preserves active tasks when the first owner turn cannot start Codex', () => {
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
      summary: CODEX_UNAVAILABLE_SUMMARY,
    });

    const updates = vi.mocked(db.updatePairedTask).mock.calls[0]?.[1];
    expect(updates).toEqual(
      expect.objectContaining({
        owner_failure_count: 1,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
      }),
    );
    expect(updates?.status).not.toBe('completed');
  });

  it('preserves merge_ready when owner finalization cannot start Codex', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        updated_at: '2026-03-28T00:00:05.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'failed',
      summary: CODEX_UNAVAILABLE_SUMMARY,
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        owner_failure_count: 1,
        arbiter_verdict: null,
        arbiter_requested_at: null,
        completion_reason: null,
      }),
    );
  });

  it('requests arbiter after repeated owner Codex account failures', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'active',
        owner_failure_count: 1,
        updated_at: '2026-03-28T00:00:05.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'failed',
      summary: CODEX_UNAVAILABLE_SUMMARY,
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'arbiter_requested',
        owner_failure_count: 2,
        arbiter_requested_at: expect.any(String),
      }),
    );
  });

  it('escalates to the user after persistent owner and arbiter Codex account failures', () => {
    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'active',
        owner_failure_count: 3,
        updated_at: '2026-03-28T00:00:05.000Z',
      }),
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'failed',
      summary: CODEX_UNAVAILABLE_SUMMARY,
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'completed',
        owner_failure_count: 4,
        arbiter_verdict: 'escalate',
        arbiter_requested_at: null,
        completion_reason: 'escalated',
      }),
    );
  });

  it('requeues owner finalization once after preserving merge_ready', () => {
    expect(
      resolvePairedFollowUpQueueAction({
        completedRole: 'owner',
        executionStatus: 'failed',
        sawOutput: false,
        taskStatus: 'merge_ready',
        ownerFailureCount: 1,
        outputSummary: CODEX_UNAVAILABLE_SUMMARY,
      }),
    ).toBe('pending');
  });

  it('queues arbiter after repeated owner finalization failures', () => {
    expect(
      resolvePairedFollowUpQueueAction({
        completedRole: 'owner',
        executionStatus: 'failed',
        sawOutput: false,
        taskStatus: 'arbiter_requested',
        ownerFailureCount: 2,
        outputSummary: CODEX_UNAVAILABLE_SUMMARY,
      }),
    ).toBe('pending');
  });
});
