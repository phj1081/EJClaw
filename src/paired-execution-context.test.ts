import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  createPairedTask: vi.fn(),
  getLatestPairedTaskForChat: vi.fn(),
  getLatestOpenPairedTaskForChat: vi.fn(),
  getPairedTaskById: vi.fn(),
  getPairedWorkspace: vi.fn(),
  updatePairedTask: vi.fn(),
  upsertPairedProject: vi.fn(),
}));

vi.mock('./paired-workspace-manager.js', () => ({
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
  completePairedExecutionContext,
  preparePairedExecutionContext,
} from './paired-execution-context.js';
import * as pairedWorkspaceManager from './paired-workspace-manager.js';
import type {
  PairedTask,
  PairedWorkspace,
  RegisteredGroup,
  RoomRoleContext,
} from './types.js';

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

function createCanonicalRepoWithCommit(commitMessage: string): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-finalize-'));
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  fs.writeFileSync(path.join(repoDir, 'README.md'), `${commitMessage}\n`);
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', commitMessage], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  return repoDir;
}

function resolveTreeRef(repoDir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function buildPairedTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'task-1',
    chat_jid: 'dc:test',
    group_folder: group.folder,
    owner_service_id: 'codex-main',
    reviewer_service_id: 'codex-review',
    title: null,
    source_ref: 'HEAD',
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 0,
    status: 'active',
    created_at: '2026-03-28T00:00:00.000Z',
    updated_at: '2026-03-28T00:00:00.000Z',
    ...overrides,
  };
}

function buildWorkspace(
  role: 'owner' | 'reviewer',
  workspaceDir: string,
): PairedWorkspace {
  return {
    id: `task-1:${role}`,
    task_id: 'task-1',
    role,
    workspace_dir: workspaceDir,
    snapshot_source_dir:
      role === 'reviewer' ? '/tmp/paired/task-1/owner' : null,
    snapshot_ref: role === 'reviewer' ? 'fingerprint-1' : null,
    status: 'ready',
    snapshot_refreshed_at:
      role === 'reviewer' ? '2026-03-28T00:00:00.000Z' : null,
    created_at: '2026-03-28T00:00:00.000Z',
    updated_at: '2026-03-28T00:00:00.000Z',
  };
}

describe('paired execution context', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(undefined);
    vi.mocked(db.getPairedTaskById).mockReturnValue(undefined);
    vi.mocked(db.getPairedWorkspace).mockReturnValue(undefined);
    vi.mocked(
      pairedWorkspaceManager.provisionOwnerWorkspaceForPairedTask,
    ).mockReturnValue({
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
        status: 'active',
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
      plan_notes: null,
      round_trip_count: 0,
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
        snapshot_ref: 'fingerprint-1',
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
      plan_notes: null,
      round_trip_count: 0,
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

  it('does not change task state when the reviewer snapshot is not ready', () => {
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-1',
      chat_jid: 'dc:test',
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 0,
      review_requested_at: null,
      status: 'active',
      created_at: '2026-03-28T00:00:00.000Z',
      updated_at: '2026-03-28T00:00:00.000Z',
    });
    vi.mocked(
      pairedWorkspaceManager.prepareReviewerWorkspaceForExecution,
    ).mockReturnValue({
      workspace: null,
      autoRefreshed: false,
      blockMessage:
        'Review snapshot is not ready yet. Wait for the owner to complete a turn so the reviewer snapshot can be prepared.',
    });

    const result = preparePairedExecutionContext({
      group,
      chatJid: 'dc:test',
      runId: 'run-general-reviewer',
      roomRoleContext: reviewerContext,
    });

    expect(result?.blockMessage).toBe(
      'Review snapshot is not ready yet. Wait for the owner to complete a turn so the reviewer snapshot can be prepared.',
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
      plan_notes: null,
      round_trip_count: 0,
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

  it('completePairedExecutionContext logs without error', () => {
    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'done',
    });

    // Should not throw; just logs.
  });

  it('completes owner finalize when only the commit object changed after approval', () => {
    const repoDir = createCanonicalRepoWithCommit('reviewed');
    const approvedSourceRef = resolveTreeRef(repoDir);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'metadata only'], {
      cwd: repoDir,
      stdio: 'ignore',
    });

    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'merge_ready',
        source_ref: approvedSourceRef,
      }),
    );
    vi.mocked(db.getPairedWorkspace).mockImplementation((_taskId, role) =>
      role === 'owner' ? buildWorkspace('owner', repoDir) : undefined,
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'DONE',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'completed' }),
    );
    expect(
      pairedWorkspaceManager.markPairedTaskReviewReady,
    ).not.toHaveBeenCalled();
  });

  it('re-triggers review when owner changed code after approval', () => {
    const repoDir = createCanonicalRepoWithCommit('reviewed');
    const approvedSourceRef = resolveTreeRef(repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'changed\n');
    execFileSync('git', ['add', 'README.md'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['commit', '-m', 'code change'], {
      cwd: repoDir,
      stdio: 'ignore',
    });

    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'merge_ready',
        source_ref: approvedSourceRef,
        round_trip_count: 1,
      }),
    );
    vi.mocked(db.getPairedWorkspace).mockImplementation((_taskId, role) =>
      role === 'owner' ? buildWorkspace('owner', repoDir) : undefined,
    );
    vi.mocked(pairedWorkspaceManager.markPairedTaskReviewReady).mockReturnValue(
      {
        ownerWorkspace: buildWorkspace('owner', repoDir),
        reviewerWorkspace: buildWorkspace(
          'reviewer',
          '/tmp/paired/task-1/reviewer',
        ),
      },
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'owner',
      status: 'succeeded',
      summary: 'DONE',
    });

    expect(
      pairedWorkspaceManager.markPairedTaskReviewReady,
    ).toHaveBeenCalledWith('task-1');
    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        round_trip_count: 2,
        review_requested_at: expect.any(String),
      }),
    );
  });

  it('records source_ref when reviewer verdict DONE arrives via failed fallback', () => {
    const repoDir = createCanonicalRepoWithCommit('reviewed');
    const approvedSourceRef = resolveTreeRef(repoDir);

    vi.mocked(db.getPairedTaskById).mockReturnValue(
      buildPairedTask({
        status: 'in_review',
        source_ref: 'stale-ref',
      }),
    );
    vi.mocked(db.getPairedWorkspace).mockImplementation((_taskId, role) =>
      role === 'owner' ? buildWorkspace('owner', repoDir) : undefined,
    );

    completePairedExecutionContext({
      taskId: 'task-1',
      role: 'reviewer',
      status: 'failed',
      summary: 'DONE',
    });

    expect(db.updatePairedTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'merge_ready',
        source_ref: approvedSourceRef,
      }),
    );
  });
});
