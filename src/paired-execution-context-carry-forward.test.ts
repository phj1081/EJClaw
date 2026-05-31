import { describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    PAIRED_CARRY_FORWARD_LATEST_OWNER_FINAL: true,
  };
});

vi.mock('./db.js', () => {
  const updatePairedTask = vi.fn();
  return {
    cancelPairedTurn: vi.fn(),
    createPairedTask: vi.fn(),
    getLatestPairedTaskForChat: vi.fn(),
    getLatestOpenPairedTaskForChat: vi.fn(),
    getPairedTaskById: vi.fn(),
    getPairedTurnById: vi.fn(),
    getPairedTurnOutputs: vi.fn(() => []),
    getPairedWorkspace: vi.fn(),
    insertPairedTurnOutput: vi.fn(),
    updatePairedTask,
    updatePairedTaskIfUnchanged: vi.fn((id, _expectedUpdatedAt, updates) => {
      updatePairedTask(id, updates);
      return true;
    }),
    upsertPairedProject: vi.fn(),
    hasActiveCiWatcherForChat: vi.fn(() => false),
    releasePairedTaskExecutionLease: vi.fn(),
  };
});

vi.mock('./paired-workspace-manager.js', () => ({
  isOwnerWorkspaceRepairNeededError: vi.fn(() => false),
  markPairedTaskReviewReady: vi.fn(),
  prepareReviewerWorkspaceForExecution: vi.fn(() => ({
    workspace: null,
    autoRefreshed: false,
  })),
  provisionOwnerWorkspaceForPairedTask: vi.fn(() => ({
    id: 'task-new:owner',
    task_id: 'task-new',
    role: 'owner',
    workspace_dir: '/tmp/paired/task-new/owner',
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

import * as db from './db.js';
import { resolveOwnerTaskForHumanMessage } from './paired-execution-context.js';
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
  serviceId: 'codex-main',
  role: 'owner',
  ownerServiceId: 'codex-main',
  reviewerServiceId: 'claude-review',
  failoverOwner: false,
};

function buildTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'task-superseded',
    chat_jid: 'dc:test',
    group_folder: group.folder,
    owner_service_id: 'codex-main',
    reviewer_service_id: 'claude-review',
    owner_agent_type: 'codex',
    reviewer_agent_type: 'claude-code',
    arbiter_agent_type: 'codex',
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
    updated_at: '2026-03-28T00:05:00.000Z',
    ...overrides,
  };
}

describe('paired execution carry-forward attachments', () => {
  it('preserves latest owner final attachments when carrying context into a superseding task', () => {
    const supersededTask = buildTask();
    const attachments = [
      {
        path: '/data/attachments/paired-turn-outputs/task/1/owner/result.png',
        name: 'result.png',
        mime: 'image/png',
      },
    ];
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: supersededTask.id,
        turn_number: 1,
        role: 'owner',
        output_text: 'TASK_DONE\n새 렌더 이미지입니다.',
        attachments,
        created_at: '2026-03-28T00:01:00.000Z',
      },
      {
        id: 2,
        task_id: supersededTask.id,
        turn_number: 2,
        role: 'reviewer',
        output_text: 'TASK_DONE\nreview approved',
        created_at: '2026-03-28T00:02:00.000Z',
      },
    ]);

    resolveOwnerTaskForHumanMessage({
      group,
      chatJid: 'dc:test',
      roomRoleContext: ownerContext,
      existingTask: supersededTask,
    });

    expect(db.insertPairedTurnOutput).toHaveBeenCalledWith(
      expect.any(String),
      0,
      'owner',
      expect.stringContaining('TASK_DONE\n새 렌더 이미지입니다.'),
      {
        createdAt: '2026-03-28T00:01:00.000Z',
        attachments,
      },
    );
  });
});
