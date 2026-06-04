import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => {
  const updatePairedTask = vi.fn();
  return {
    createPairedTask: vi.fn(),
    getLatestPairedTaskForChat: vi.fn(),
    getLatestOpenPairedTaskForChat: vi.fn(),
    getPairedTaskById: vi.fn(),
    getPairedTurnOutputs: vi.fn(() => []),
    insertPairedTurnOutput: vi.fn(),
    updatePairedTask,
    updatePairedTaskIfUnchanged: vi.fn((id, _expectedUpdatedAt, updates) => {
      updatePairedTask(id, updates);
      return true;
    }),
    upsertPairedProject: vi.fn(),
  };
});

vi.mock('./paired-workspace-manager.js', () => ({
  isOwnerWorkspaceRepairNeededError: vi.fn(() => false),
  markPairedTaskReviewReady: vi.fn(),
  prepareReviewerWorkspaceForExecution: vi.fn(),
  provisionOwnerWorkspaceForPairedTask: vi.fn(() => ({
    id: 'task-1:owner',
    task_id: 'task-1',
    role: 'owner',
    workspace_dir: '/tmp/paired/task-1/owner',
    snapshot_source_dir: null,
    snapshot_ref: null,
    status: 'ready',
    snapshot_refreshed_at: null,
    created_at: '2026-03-28T00:00:00.000Z',
    updated_at: '2026-03-28T00:00:00.000Z',
  })),
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
import { preparePairedExecutionContext } from './paired-execution-context.js';
import type { PairedTask, RegisteredGroup, RoomRoleContext } from './types.js';

const group: RegisteredGroup = {
  name: 'Paired Room',
  folder: 'paired-room',
  trigger: '@codex',
  added_at: '2026-03-28T00:00:00.000Z',
  agentType: 'codex',
  workDir: '/repo/canonical',
};

const ownerContext: RoomRoleContext = {
  serviceId: config.CODEX_MAIN_SERVICE_ID,
  role: 'owner',
  ownerServiceId: config.CODEX_MAIN_SERVICE_ID,
  reviewerServiceId: config.REVIEWER_SERVICE_ID_FOR_TYPE,
  failoverOwner: false,
};

function buildPairedTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'task-1',
    chat_jid: 'dc:test',
    group_folder: group.folder,
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

describe('paired owner follow-up preparation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(db.getPairedTaskById).mockReturnValue(undefined);
  });

  it('does not reset owner failure counters for scheduled owner follow-up turns', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(
      buildPairedTask({
        status: 'active',
        owner_failure_count: 1,
        owner_step_done_streak: 2,
        empty_step_done_streak: 2,
      }),
    );

    preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-owner-follow-up-no-reset',
      roomRoleContext: ownerContext,
      hasHumanMessage: true,
      pairedTurnIdentity: {
        turnId: 'task-1:2026-03-28T00:00:00.000Z:owner-follow-up',
        taskId: 'task-1',
        taskUpdatedAt: '2026-03-28T00:00:00.000Z',
        intentKind: 'owner-follow-up',
        role: 'owner',
      },
    });

    expect(db.updatePairedTask).not.toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        round_trip_count: 0,
        owner_failure_count: 0,
        owner_step_done_streak: 0,
        empty_step_done_streak: 0,
      }),
    );
  });
});
