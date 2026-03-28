import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  createPairedArtifact: vi.fn(),
  createPairedExecution: vi.fn(),
  createPairedTask: vi.fn(),
  getLatestOpenPairedTaskForChat: vi.fn(),
  getPairedExecutionById: vi.fn(),
  getPairedTaskById: vi.fn(),
  getPairedWorkspace: vi.fn(),
  listPairedArtifactsForTask: vi.fn(),
  updatePairedExecution: vi.fn(),
  updatePairedTask: vi.fn(),
  upsertPairedProject: vi.fn(),
}));

vi.mock('./paired-workspace-manager.js', () => ({
  PLAN_REVIEW_REQUIRED_BLOCK_MESSAGE:
    'Plan review is required before formal review for this high-risk task.',
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

import * as db from './db.js';
import {
  approveRoomPlan,
  formatRoomReviewReadyMessage,
  markRoomReviewReady,
  preparePairedExecutionContext,
  recordRoomPlan,
  requestRoomPlanChanges,
  setRoomTaskRiskLevel,
} from './paired-execution-context.js';
import * as pairedWorkspaceManager from './paired-workspace-manager.js';
import type { RegisteredGroup, RoomRoleContext } from './types.js';

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
  reviewerServiceId: 'codex-review',
  failoverOwner: false,
};

const reviewerContext: RoomRoleContext = {
  serviceId: 'codex-review',
  role: 'reviewer',
  ownerServiceId: 'codex-main',
  reviewerServiceId: 'codex-review',
  failoverOwner: false,
};

describe('paired execution context', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(undefined);
    vi.mocked(db.getPairedExecutionById).mockReturnValue(undefined);
    vi.mocked(db.getPairedTaskById).mockReturnValue(undefined);
    vi.mocked(db.getPairedWorkspace).mockReturnValue(undefined);
    vi.mocked(db.listPairedArtifactsForTask).mockReturnValue([]);
    vi.mocked(
      pairedWorkspaceManager.provisionOwnerWorkspaceForPairedTask,
    ).mockReturnValue({
      id: 'task-1:owner',
      task_id: 'task-1',
      role: 'owner',
      workspace_dir: '/tmp/paired/task-1/owner',
      snapshot_source_dir: null,
      snapshot_source_fingerprint: null,
      status: 'ready',
      snapshot_refreshed_at: null,
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(
      pairedWorkspaceManager.prepareReviewerWorkspaceForExecution,
    ).mockReturnValue({
      workspace: null,
      autoRefreshed: false,
    });
  });

  it('creates an owner execution with a worktree override', () => {
    const result = preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-1',
      roomRoleContext: ownerContext,
    });

    expect(db.upsertPairedProject).toHaveBeenCalled();
    expect(db.createPairedTask).toHaveBeenCalledTimes(1);
    expect(db.createPairedTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task_policy: 'autonomous',
        risk_level: 'low',
        plan_status: 'not_requested',
        status: 'active',
      }),
    );
    expect(db.createPairedExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'run-1:codex-main',
        role: 'owner',
        workspace_id: 'task-1:owner',
      }),
    );
    expect(result?.envOverrides).toMatchObject({
      EJCLAW_WORK_DIR: '/tmp/paired/task-1/owner',
      EJCLAW_PAIRED_ROLE: 'owner',
    });
  });

  it('uses the reviewer snapshot after lazy auto-refresh and marks the task in_review', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'low',
      plan_status: 'not_requested',
      review_requested_at: '2026-03-28T00:00:00.000Z',
      status: 'review_ready',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(
      pairedWorkspaceManager.prepareReviewerWorkspaceForExecution,
    ).mockReturnValue({
      workspace: {
        id: 'task-1:reviewer',
        task_id: 'task-1',
        role: 'reviewer',
        workspace_dir: '/tmp/paired/task-1/reviewer',
        snapshot_source_dir: '/tmp/paired/task-1/owner',
        snapshot_source_fingerprint: 'fingerprint-1',
        status: 'ready',
        snapshot_refreshed_at: '2026-03-28T00:00:00.000Z',
        created_at: '2026-03-28T00:00:00.000Z',
        updated_at: '2026-03-28T00:00:00.000Z',
      },
      autoRefreshed: true,
    });
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'low',
      plan_status: 'approved',
      review_requested_at: '2026-03-28T00:00:00.000Z',
      status: 'review_ready',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    const result = preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-2',
      roomRoleContext: reviewerContext,
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'in_review' }),
    );
    expect(result?.envOverrides).toMatchObject({
      EJCLAW_WORK_DIR: '/tmp/paired/task-1/reviewer',
      EJCLAW_REVIEWER_RUNTIME: '1',
      EJCLAW_PAIRED_ROLE: 'reviewer',
    });
  });

  it('does not change task state for a general reviewer turn before /review', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'low',
      plan_status: 'not_requested',
      review_requested_at: null,
      status: 'draft',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(
      pairedWorkspaceManager.prepareReviewerWorkspaceForExecution,
    ).mockReturnValue({
      workspace: null,
      autoRefreshed: false,
      blockMessage:
        'Review snapshot is not ready yet. Ask the owner to run /review (or /review-ready) after preparing changes.',
    });

    const result = preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-general-reviewer',
      roomRoleContext: reviewerContext,
    });

    expect(result?.blockMessage).toBe(
      'Review snapshot is not ready yet. Ask the owner to run /review (or /review-ready) after preparing changes.',
    );
    expect(db.updatePairedTask).not.toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'in_review' }),
    );
  });

  it('blocks reviewer execution when an in-review snapshot became stale', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'high',
      plan_status: 'approved',
      review_requested_at: '2026-03-28T00:00:00.000Z',
      status: 'in_review',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(
      pairedWorkspaceManager.prepareReviewerWorkspaceForExecution,
    ).mockReturnValue({
      workspace: null,
      autoRefreshed: false,
      blockMessage:
        'Review snapshot is stale after owner changes. Retry the review once to refresh against the latest owner workspace.',
    });

    const result = preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-stale-reviewer',
      roomRoleContext: reviewerContext,
    });

    expect(result?.blockMessage).toBe(
      'Review snapshot is stale after owner changes. Retry the review once to refresh against the latest owner workspace.',
    );
    expect(result?.envOverrides.EJCLAW_WORK_DIR).toBeUndefined();
  });

  it('marks the active room task review-ready through the workspace manager', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'low',
      plan_status: 'not_requested',
      review_requested_at: null,
      status: 'draft',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'low',
      plan_status: 'approved',
      review_requested_at: '2026-03-28T00:00:00.000Z',
      status: 'review_ready',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(pairedWorkspaceManager.markPairedTaskReviewReady).mockReturnValue(
      {
        ownerWorkspace: {
          id: 'task-1:owner',
          task_id: 'task-1',
          role: 'owner',
          workspace_dir: '/tmp/paired/task-1/owner',
          snapshot_source_dir: null,
          snapshot_source_fingerprint: null,
          status: 'ready',
          snapshot_refreshed_at: null,
          created_at: '2026-03-28T00:00:00.000Z',
          updated_at: '2026-03-28T00:00:00.000Z',
        },
        reviewerWorkspace: {
          id: 'task-1:reviewer',
          task_id: 'task-1',
          role: 'reviewer',
          workspace_dir: '/tmp/paired/task-1/reviewer',
          snapshot_source_dir: '/tmp/paired/task-1/owner',
          snapshot_source_fingerprint: 'fingerprint-1',
          status: 'ready',
          snapshot_refreshed_at: '2026-03-28T00:00:00.000Z',
          created_at: '2026-03-28T00:00:00.000Z',
          updated_at: '2026-03-28T00:00:00.000Z',
        },
      },
    );

    const result = markRoomReviewReady({
      group,
      chatJid: 'dc:test',
      roomRoleContext: ownerContext,
    });

    expect(
      pairedWorkspaceManager.markPairedTaskReviewReady,
    ).toHaveBeenCalledWith('task-1');
    expect(result?.status).toBe('ready');
    if (!result || result.status !== 'ready') {
      throw new Error('expected ready review result');
    }
    expect(result.task.status).toBe('review_ready');
  });

  it('keeps review_pending and returns a pending result when owner workspace is not ready', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'low',
      plan_status: 'not_requested',
      review_requested_at: null,
      status: 'draft',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'low',
      plan_status: 'not_requested',
      review_requested_at: '2026-03-29T00:00:00.000Z',
      status: 'review_pending',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-29T00:00:00.000Z',
    });
    vi.mocked(pairedWorkspaceManager.markPairedTaskReviewReady).mockReturnValue(
      null,
    );

    const result = markRoomReviewReady({
      group,
      chatJid: 'dc:test',
      roomRoleContext: ownerContext,
    });

    expect(result).toEqual({
      status: 'pending',
      task: expect.objectContaining({
        id: 'task-1',
        status: 'review_pending',
      }),
      pendingReason: 'owner-workspace-not-ready',
    });
    expect(formatRoomReviewReadyMessage(result)).toBe(
      [
        'Review request recorded, but the owner workspace is not ready yet.',
        '- Task: task-1',
        'The task stays review_pending until the owner workspace is prepared.',
      ].join('\n'),
    );
  });

  it('blocks /review for high-risk tasks until the plan is approved', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'high',
      plan_status: 'pending',
      review_requested_at: null,
      status: 'plan_review_pending',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    const result = markRoomReviewReady({
      group,
      chatJid: 'dc:test',
      roomRoleContext: ownerContext,
    });

    expect(
      pairedWorkspaceManager.markPairedTaskReviewReady,
    ).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'blocked',
      task: expect.objectContaining({
        id: 'task-1',
        risk_level: 'high',
        plan_status: 'pending',
      }),
      blockedReason: 'plan-review-required',
    });
    expect(formatRoomReviewReadyMessage(result)).toBe(
      [
        'Plan review is required before formal review for this high-risk task.',
        '- Task: task-1',
        '- Plan status: pending',
        'Ask the owner to record a plan and have the reviewer approve it before /review.',
      ].join('\n'),
    );
  });

  it('raises a task to high risk and moves it into plan_review_pending', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'low',
      plan_status: 'not_requested',
      review_requested_at: null,
      status: 'active',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'high',
      plan_status: 'not_requested',
      review_requested_at: null,
      status: 'plan_review_pending',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-29T00:00:00.000Z',
    });

    const message = setRoomTaskRiskLevel({
      group,
      chatJid: 'dc:test',
      roomRoleContext: ownerContext,
      riskLevel: 'high',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        risk_level: 'high',
        plan_status: 'not_requested',
        status: 'plan_review_pending',
      }),
    );
    expect(message).toBe(
      [
        'Task risk updated.',
        '- Task: task-1',
        '- Risk: high',
        '- Status: plan_review_pending',
      ].join('\n'),
    );
  });

  it('records plan artifacts for a high-risk task and keeps it pending review', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'high',
      plan_status: 'not_requested',
      review_requested_at: null,
      status: 'plan_review_pending',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'high',
      plan_status: 'pending',
      review_requested_at: null,
      status: 'plan_review_pending',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-29T00:00:00.000Z',
    });

    const message = recordRoomPlan({
      group,
      chatJid: 'dc:test',
      roomRoleContext: ownerContext,
      planBrief: 'ship governance gate',
      acceptanceCriteria: 'high risk blocks /review',
      riskSummary: 'runtime state drift',
    });

    expect(db.createPairedArtifact).toHaveBeenCalledTimes(3);
    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        plan_status: 'pending',
        status: 'plan_review_pending',
      }),
    );
    expect(message).toBe(
      [
        'Plan recorded.',
        '- Task: task-1',
        '- Plan status: pending',
        '- Status: plan_review_pending',
      ].join('\n'),
    );
  });

  it('approves a high-risk plan from the reviewer side once plan artifacts exist', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'high',
      plan_status: 'pending',
      review_requested_at: null,
      status: 'plan_review_pending',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(db.listPairedArtifactsForTask).mockReturnValue([
      {
        id: 1,
        task_id: 'task-1',
        execution_id: null,
        service_id: 'codex-main',
        artifact_type: 'plan_brief',
        title: null,
        content: 'brief',
        file_path: null,
        created_at: '2026-03-29T00:00:00.000Z',
      },
      {
        id: 2,
        task_id: 'task-1',
        execution_id: null,
        service_id: 'codex-main',
        artifact_type: 'acceptance_criteria',
        title: null,
        content: 'criteria',
        file_path: null,
        created_at: '2026-03-29T00:00:01.000Z',
      },
      {
        id: 3,
        task_id: 'task-1',
        execution_id: null,
        service_id: 'codex-main',
        artifact_type: 'risk_summary',
        title: null,
        content: 'risk',
        file_path: null,
        created_at: '2026-03-29T00:00:02.000Z',
      },
    ]);
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'high',
      plan_status: 'approved',
      review_requested_at: null,
      status: 'active',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-29T00:00:00.000Z',
    });

    const message = approveRoomPlan({
      group,
      chatJid: 'dc:test',
      roomRoleContext: reviewerContext,
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        plan_status: 'approved',
        status: 'active',
      }),
    );
    expect(message).toBe(
      ['Plan approved.', '- Task: task-1', '- Status: active'].join('\n'),
    );
  });

  it('requests plan changes from the reviewer side and keeps the task pending', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'high',
      plan_status: 'pending',
      review_requested_at: null,
      status: 'plan_review_pending',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      task_policy: 'autonomous',
      risk_level: 'high',
      plan_status: 'changes_requested',
      review_requested_at: null,
      status: 'plan_review_pending',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-29T00:00:00.000Z',
    });

    const message = requestRoomPlanChanges({
      group,
      chatJid: 'dc:test',
      roomRoleContext: reviewerContext,
      note: 'tighten acceptance criteria',
    });

    expect(db.createPairedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 'task-1',
        service_id: 'codex-review',
        artifact_type: 'comment',
        content: 'tighten acceptance criteria',
      }),
    );
    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        plan_status: 'changes_requested',
        status: 'plan_review_pending',
      }),
    );
    expect(message).toBe(
      [
        'Plan changes requested.',
        '- Task: task-1',
        '- Plan status: changes_requested',
        '- Status: plan_review_pending',
      ].join('\n'),
    );
  });
});
