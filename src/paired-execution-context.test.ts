import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  applyPairedEvent: vi.fn(),
  cancelSupersededPairedExecutions: vi.fn(() => 0),
  createPairedArtifact: vi.fn(),
  createPairedExecution: vi.fn(),
  createPairedTask: vi.fn(),
  getLatestOpenPairedTaskForChat: vi.fn(),
  getPairedExecutionById: vi.fn(),
  getPairedTaskById: vi.fn(),
  getPairedWorkspace: vi.fn(),
  listPairedArtifactsForTask: vi.fn(),
  listPairedEventsForTask: vi.fn(),
  listPairedExecutionsForTask: vi.fn(),
  updatePairedExecution: vi.fn(),
  updatePairedTask: vi.fn(),
  upsertPairedProject: vi.fn(),
}));

vi.mock('./paired-workspace-manager.js', () => ({
  PLAN_REVIEW_REQUIRED_BLOCK_MESSAGE:
    'Plan review is required before formal review for this high-risk task.',
  hasReviewableOwnerWorkspaceChanges: vi.fn(),
  markPairedTaskReviewReady: vi.fn(),
  prepareReviewerWorkspaceForExecution: vi.fn(),
  provisionOwnerWorkspaceForPairedTask: vi.fn(),
  resolvePairedTaskSourceFingerprint: vi.fn(),
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
  completePairedExecutionContext,
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

async function importExecutionContextForService(serviceId: string) {
  vi.resetModules();

  const dbModule = {
    applyPairedEvent: vi.fn(),
    cancelSupersededPairedExecutions: vi.fn(() => 0),
    createPairedArtifact: vi.fn(),
    createPairedExecution: vi.fn(),
    createPairedTask: vi.fn(),
    getLatestOpenPairedTaskForChat: vi.fn(),
    getPairedExecutionById: vi.fn(),
    getPairedTaskById: vi.fn(),
    getPairedWorkspace: vi.fn(),
    listPairedArtifactsForTask: vi.fn(),
    listPairedEventsForTask: vi.fn(),
    listPairedExecutionsForTask: vi.fn(),
    updatePairedExecution: vi.fn(),
    updatePairedTask: vi.fn(),
    upsertPairedProject: vi.fn(),
  };
  dbModule.applyPairedEvent.mockImplementation(({ event, onApply }) => ({
    applied: true,
    event: { id: 1, ...event },
    result: onApply ? onApply() : null,
  }));
  dbModule.getLatestOpenPairedTaskForChat.mockReturnValue(undefined);
  dbModule.getPairedExecutionById.mockReturnValue(undefined);
  dbModule.getPairedTaskById.mockReturnValue(undefined);
  dbModule.getPairedWorkspace.mockReturnValue(undefined);
  dbModule.listPairedArtifactsForTask.mockReturnValue([]);
  dbModule.listPairedEventsForTask.mockReturnValue([]);
  dbModule.listPairedExecutionsForTask.mockReturnValue([]);

  const pairedWorkspaceManagerModule = {
    PLAN_REVIEW_REQUIRED_BLOCK_MESSAGE:
      'Plan review is required before formal review for this high-risk task.',
    hasReviewableOwnerWorkspaceChanges: vi.fn(),
    markPairedTaskReviewReady: vi.fn(),
    prepareReviewerWorkspaceForExecution: vi.fn(),
    provisionOwnerWorkspaceForPairedTask: vi.fn(),
    resolvePairedTaskSourceFingerprint: vi.fn(),
  };
  pairedWorkspaceManagerModule.provisionOwnerWorkspaceForPairedTask.mockReturnValue(
    {
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
  );
  pairedWorkspaceManagerModule.prepareReviewerWorkspaceForExecution.mockReturnValue(
    {
      workspace: null,
      autoRefreshed: false,
    },
  );
  pairedWorkspaceManagerModule.hasReviewableOwnerWorkspaceChanges.mockReturnValue(
    true,
  );
  pairedWorkspaceManagerModule.resolvePairedTaskSourceFingerprint.mockReturnValue(
    'fingerprint-1',
  );

  vi.doMock('./db.js', () => dbModule);
  vi.doMock('./paired-workspace-manager.js', () => pairedWorkspaceManagerModule);
  vi.doMock('./logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));
  vi.doMock('./config.js', async () => {
    const actual =
      await vi.importActual<typeof import('./config.js')>('./config.js');
    return {
      ...actual,
      SERVICE_ID: serviceId,
    };
  });

  const module = await import('./paired-execution-context.js');
  return {
    dbModule,
    pairedWorkspaceManagerModule,
    markRoomReviewReady: module.markRoomReviewReady,
  };
}

describe('paired execution context', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(db.applyPairedEvent).mockImplementation(({ event, onApply }) => ({
      applied: true,
      event: { id: 1, ...event },
      result: onApply ? onApply() : null,
    }));
    vi.mocked(db.cancelSupersededPairedExecutions).mockReturnValue(0);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(undefined);
    vi.mocked(db.getPairedExecutionById).mockReturnValue(undefined);
    vi.mocked(db.getPairedTaskById).mockReturnValue(undefined);
    vi.mocked(db.getPairedWorkspace).mockReturnValue(undefined);
    vi.mocked(db.listPairedArtifactsForTask).mockReturnValue([]);
    vi.mocked(db.listPairedEventsForTask).mockReturnValue([]);
    vi.mocked(db.listPairedExecutionsForTask).mockReturnValue([]);
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
    vi.mocked(
      pairedWorkspaceManager.hasReviewableOwnerWorkspaceChanges,
    ).mockReturnValue(true);
    vi.mocked(
      pairedWorkspaceManager.resolvePairedTaskSourceFingerprint,
    ).mockReturnValue('fingerprint-1');
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

  it('does not self-cancel when the same execution resumes', () => {
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
    vi.mocked(db.getPairedExecutionById).mockReturnValue({
      id: 'run-1:codex-main',
      task_id: 'task-1',
      service_id: 'codex-main',
      role: 'owner',
      workspace_id: 'task-1:owner',
      checkpoint_fingerprint: 'fingerprint-1',
      status: 'running',
      summary: null,
      created_at: '2026-03-28T00:00:00.000Z',
      started_at: '2026-03-28T00:00:00.000Z',
      completed_at: null,
    });

    preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-1',
      roomRoleContext: ownerContext,
    });

    expect(db.cancelSupersededPairedExecutions).toHaveBeenCalledWith({
      taskId: 'task-1',
      role: 'owner',
      exceptExecutionId: 'run-1:codex-main',
      note: 'Superseded by a newer execution for the same task and role.',
    });
  });

  it('auto-requests review when a low-risk owner execution completes', () => {
    vi.mocked(pairedWorkspaceManager.resolvePairedTaskSourceFingerprint).mockReturnValue(
      'fingerprint-2',
    );
    vi.mocked(db.getPairedExecutionById).mockReturnValue({
      id: 'run-1:codex-main',
      task_id: 'task-1',
      service_id: 'codex-main',
      role: 'owner',
      workspace_id: 'task-1:owner',
      checkpoint_fingerprint: 'fingerprint-1',
      status: 'running',
      summary: null,
      created_at: '2026-03-28T00:00:00.000Z',
      started_at: '2026-03-28T00:00:00.000Z',
      completed_at: null,
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
      review_requested_at: null,
      status: 'active',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(db.getPairedWorkspace).mockImplementation((taskId, role) => {
      if (taskId !== 'task-1' || role !== 'owner') {
        return undefined;
      }
      return {
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
      };
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

    completePairedExecutionContext({
      executionId: 'run-1:codex-main',
      status: 'succeeded',
      summary: 'done',
    });

    expect(db.updatePairedExecution).toHaveBeenCalledWith('run-1:codex-main', {
      status: 'succeeded',
      summary: 'done',
      completed_at: expect.any(String),
    });
    expect(db.applyPairedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          task_id: 'task-1',
          event_type: 'request_review',
          source_fingerprint: 'fingerprint-2',
          dedupe_key: 'auto-request-review:fingerprint-2',
        }),
      }),
    );
    expect(
      pairedWorkspaceManager.markPairedTaskReviewReady,
    ).toHaveBeenCalledWith('task-1');
  });

  it('does not auto-request review for a successful owner turn without reviewable changes', () => {
    vi.mocked(db.getPairedExecutionById).mockReturnValue({
      id: 'run-1:codex-main',
      task_id: 'task-1',
      service_id: 'codex-main',
      role: 'owner',
      workspace_id: 'task-1:owner',
      status: 'running',
      summary: null,
      created_at: '2026-03-28T00:00:00.000Z',
      started_at: '2026-03-28T00:00:00.000Z',
      completed_at: null,
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
      review_requested_at: null,
      status: 'active',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(db.getPairedWorkspace).mockReturnValue({
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
      pairedWorkspaceManager.hasReviewableOwnerWorkspaceChanges,
    ).mockReturnValue(false);

    completePairedExecutionContext({
      executionId: 'run-1:codex-main',
      status: 'succeeded',
      summary: 'done',
    });

    expect(db.applyPairedEvent).not.toHaveBeenCalled();
    expect(pairedWorkspaceManager.markPairedTaskReviewReady).not.toHaveBeenCalled();
  });

  it('does not auto-request review twice for the same fingerprint', () => {
    vi.mocked(db.getPairedExecutionById).mockReturnValue({
      id: 'run-1:codex-main',
      task_id: 'task-1',
      service_id: 'codex-main',
      role: 'owner',
      workspace_id: 'task-1:owner',
      status: 'running',
      summary: null,
      created_at: '2026-03-28T00:00:00.000Z',
      started_at: '2026-03-28T00:00:00.000Z',
      completed_at: null,
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
      review_requested_at: null,
      status: 'active',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(db.getPairedWorkspace).mockReturnValue({
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
    vi.mocked(db.listPairedEventsForTask).mockReturnValue([
      {
        id: 1,
        task_id: 'task-1',
        event_type: 'request_review',
        actor_role: 'owner',
        source_service_id: 'codex-main',
        source_fingerprint: 'fingerprint-1',
        dedupe_key: 'auto-request-review:fingerprint-1',
        payload_json: null,
        created_at: '2026-03-28T00:00:00.000Z',
      },
    ]);

    completePairedExecutionContext({
      executionId: 'run-1:codex-main',
      status: 'succeeded',
      summary: 'done',
    });

    expect(db.applyPairedEvent).not.toHaveBeenCalled();
    expect(pairedWorkspaceManager.markPairedTaskReviewReady).not.toHaveBeenCalled();
  });

  it('does not auto-request review for high-risk tasks before plan approval', () => {
    vi.mocked(db.getPairedExecutionById).mockReturnValue({
      id: 'run-1:codex-main',
      task_id: 'task-1',
      service_id: 'codex-main',
      role: 'owner',
      workspace_id: 'task-1:owner',
      status: 'running',
      summary: null,
      created_at: '2026-03-28T00:00:00.000Z',
      started_at: '2026-03-28T00:00:00.000Z',
      completed_at: null,
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
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(db.getPairedWorkspace).mockReturnValue({
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

    completePairedExecutionContext({
      executionId: 'run-1:codex-main',
      status: 'succeeded',
      summary: 'done',
    });

    expect(db.applyPairedEvent).not.toHaveBeenCalled();
    expect(pairedWorkspaceManager.markPairedTaskReviewReady).not.toHaveBeenCalled();
  });

  it('does not auto-request review after a reviewer execution completes', () => {
    vi.mocked(db.getPairedExecutionById).mockReturnValue({
      id: 'run-1:codex-review',
      task_id: 'task-1',
      service_id: 'codex-review',
      role: 'reviewer',
      workspace_id: 'task-1:reviewer',
      status: 'running',
      summary: null,
      created_at: '2026-03-28T00:00:00.000Z',
      started_at: '2026-03-28T00:00:00.000Z',
      completed_at: null,
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
      review_requested_at: null,
      status: 'active',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });

    completePairedExecutionContext({
      executionId: 'run-1:codex-review',
      status: 'succeeded',
      summary: 'done',
    });

    expect(db.applyPairedEvent).not.toHaveBeenCalled();
    expect(pairedWorkspaceManager.markPairedTaskReviewReady).not.toHaveBeenCalled();
  });

  it('does not reopen review from a cancelled stale owner execution', () => {
    vi.mocked(db.getPairedExecutionById).mockReturnValue({
      id: 'run-1:codex-main',
      task_id: 'task-1',
      service_id: 'codex-main',
      role: 'owner',
      workspace_id: 'task-1:owner',
      checkpoint_fingerprint: 'fingerprint-1',
      status: 'cancelled',
      summary: null,
      created_at: '2026-03-28T00:00:00.000Z',
      started_at: '2026-03-28T00:00:00.000Z',
      completed_at: null,
    });

    completePairedExecutionContext({
      executionId: 'run-1:codex-main',
      status: 'succeeded',
      summary: 'stale',
    });

    expect(db.updatePairedExecution).toHaveBeenCalledWith(
      'run-1:codex-main',
      expect.objectContaining({
        status: 'cancelled',
      }),
    );
    expect(db.applyPairedEvent).not.toHaveBeenCalled();
    expect(pairedWorkspaceManager.markPairedTaskReviewReady).not.toHaveBeenCalled();
  });

  it('does not reopen review from an older owner execution when a newer owner execution already failed', () => {
    vi.mocked(db.getPairedExecutionById).mockReturnValue({
      id: 'run-1:codex-main',
      task_id: 'task-1',
      service_id: 'codex-main',
      role: 'owner',
      workspace_id: 'task-1:owner',
      checkpoint_fingerprint: 'fingerprint-1',
      status: 'running',
      summary: null,
      created_at: '2026-03-28T00:00:00.000Z',
      started_at: '2026-03-28T00:00:00.000Z',
      completed_at: null,
    });
    vi.mocked(db.listPairedExecutionsForTask).mockReturnValue([
      {
        id: 'run-1:codex-main',
        task_id: 'task-1',
        service_id: 'codex-main',
        role: 'owner',
        workspace_id: 'task-1:owner',
        checkpoint_fingerprint: 'fingerprint-1',
        status: 'running',
        summary: null,
        created_at: '2026-03-28T00:00:00.000Z',
        started_at: '2026-03-28T00:00:00.000Z',
        completed_at: null,
      },
      {
        id: 'run-2:codex-main',
        task_id: 'task-1',
        service_id: 'codex-main',
        role: 'owner',
        workspace_id: 'task-1:owner',
        checkpoint_fingerprint: 'fingerprint-2',
        status: 'failed',
        summary: 'newer',
        created_at: '2026-03-28T00:01:00.000Z',
        started_at: '2026-03-28T00:01:00.000Z',
        completed_at: '2026-03-28T00:02:00.000Z',
      },
    ]);

    completePairedExecutionContext({
      executionId: 'run-1:codex-main',
      status: 'succeeded',
      summary: 'stale-after-failed',
    });

    expect(db.updatePairedExecution).toHaveBeenCalledWith(
      'run-1:codex-main',
      expect.objectContaining({
        status: 'succeeded',
        summary: 'stale-after-failed',
      }),
    );
    expect(db.applyPairedEvent).not.toHaveBeenCalled();
    expect(pairedWorkspaceManager.markPairedTaskReviewReady).not.toHaveBeenCalled();
  });

  it('does not reopen review from an older owner execution when a newer owner execution already succeeded', () => {
    vi.mocked(db.getPairedExecutionById).mockReturnValue({
      id: 'run-1:codex-main',
      task_id: 'task-1',
      service_id: 'codex-main',
      role: 'owner',
      workspace_id: 'task-1:owner',
      checkpoint_fingerprint: 'fingerprint-1',
      status: 'running',
      summary: null,
      created_at: '2026-03-28T00:00:00.000Z',
      started_at: '2026-03-28T00:00:00.000Z',
      completed_at: null,
    });
    vi.mocked(db.listPairedExecutionsForTask).mockReturnValue([
      {
        id: 'run-1:codex-main',
        task_id: 'task-1',
        service_id: 'codex-main',
        role: 'owner',
        workspace_id: 'task-1:owner',
        checkpoint_fingerprint: 'fingerprint-1',
        status: 'running',
        summary: null,
        created_at: '2026-03-28T00:00:00.000Z',
        started_at: '2026-03-28T00:00:00.000Z',
        completed_at: null,
      },
      {
        id: 'run-2:codex-main',
        task_id: 'task-1',
        service_id: 'codex-main',
        role: 'owner',
        workspace_id: 'task-1:owner',
        checkpoint_fingerprint: 'fingerprint-2',
        status: 'succeeded',
        summary: 'newer',
        created_at: '2026-03-28T00:01:00.000Z',
        started_at: '2026-03-28T00:01:00.000Z',
        completed_at: '2026-03-28T00:02:00.000Z',
      },
    ]);

    completePairedExecutionContext({
      executionId: 'run-1:codex-main',
      status: 'succeeded',
      summary: 'stale-after-succeeded',
    });

    expect(db.updatePairedExecution).toHaveBeenCalledWith(
      'run-1:codex-main',
      expect.objectContaining({
        status: 'succeeded',
        summary: 'stale-after-succeeded',
      }),
    );
    expect(db.applyPairedEvent).not.toHaveBeenCalled();
    expect(pairedWorkspaceManager.markPairedTaskReviewReady).not.toHaveBeenCalled();
  });

  it('records a new checkpoint and returns the task to review_pending when owner changes arrive during in_review', () => {
    vi.mocked(db.getPairedExecutionById).mockReturnValue({
      id: 'run-1:codex-main',
      task_id: 'task-1',
      service_id: 'codex-main',
      role: 'owner',
      workspace_id: 'task-1:owner',
      status: 'running',
      summary: null,
      created_at: '2026-03-28T00:00:00.000Z',
      started_at: '2026-03-28T00:00:00.000Z',
      completed_at: null,
    });
    vi.mocked(pairedWorkspaceManager.resolvePairedTaskSourceFingerprint).mockReturnValue(
      'fingerprint-2',
    );
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
      review_requested_at: '2026-03-28T00:00:00.000Z',
      status: 'in_review',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(db.getPairedWorkspace).mockReturnValue({
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

    completePairedExecutionContext({
      executionId: 'run-1:codex-main',
      status: 'succeeded',
      summary: 'updated',
    });

    expect(db.applyPairedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          task_id: 'task-1',
          event_type: 'request_review',
          source_fingerprint: 'fingerprint-2',
          dedupe_key: 'auto-request-review:fingerprint-2',
        }),
      }),
    );
    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'review_pending',
        review_requested_at: expect.any(String),
      }),
    );
    expect(db.cancelSupersededPairedExecutions).toHaveBeenCalledWith({
      taskId: 'task-1',
      role: 'reviewer',
      note: 'Superseded by a newer review checkpoint.',
    });
    expect(pairedWorkspaceManager.markPairedTaskReviewReady).not.toHaveBeenCalled();
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

  it('returns ready for /review on the owner service', async () => {
    const {
      dbModule,
      pairedWorkspaceManagerModule,
      markRoomReviewReady: isolatedMarkRoomReviewReady,
    } = await importExecutionContextForService('codex-main');

    dbModule.getLatestOpenPairedTaskForChat.mockReturnValue({
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
    dbModule.getPairedTaskById.mockReturnValue({
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
    pairedWorkspaceManagerModule.markPairedTaskReviewReady.mockReturnValue({
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
    });

    const result = isolatedMarkRoomReviewReady({
      group,
      chatJid: 'dc:test',
      roomRoleContext: ownerContext,
    });

    expect(
      pairedWorkspaceManagerModule.provisionOwnerWorkspaceForPairedTask,
    ).toHaveBeenCalledWith('task-1');
    expect(
      pairedWorkspaceManagerModule.markPairedTaskReviewReady,
    ).toHaveBeenCalledWith('task-1');
    expect(result?.status).toBe('ready');
    if (!result || result.status !== 'ready') {
      throw new Error('expected ready review result');
    }
    expect(result.task.status).toBe('review_ready');
  });

  it('returns pending for /review on the reviewer service before the owner workspace is visible', async () => {
    const {
      dbModule,
      pairedWorkspaceManagerModule,
      markRoomReviewReady: isolatedMarkRoomReviewReady,
    } = await importExecutionContextForService('codex-review');

    dbModule.getLatestOpenPairedTaskForChat.mockReturnValue({
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
    dbModule.getPairedTaskById.mockReturnValue({
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
      status: 'review_pending',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    pairedWorkspaceManagerModule.markPairedTaskReviewReady.mockReturnValue(null);

    const result = isolatedMarkRoomReviewReady({
      group,
      chatJid: 'dc:test',
      roomRoleContext: ownerContext,
    });

    expect(
      pairedWorkspaceManagerModule.provisionOwnerWorkspaceForPairedTask,
    ).not.toHaveBeenCalled();
    expect(dbModule.getPairedWorkspace).toHaveBeenCalledWith('task-1', 'owner');
    expect(
      pairedWorkspaceManagerModule.markPairedTaskReviewReady,
    ).toHaveBeenCalledWith('task-1');
    expect(result).toEqual({
      status: 'pending',
      task: expect.objectContaining({
        id: 'task-1',
        status: 'review_pending',
      }),
      pendingReason: 'owner-workspace-not-ready',
    });
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
