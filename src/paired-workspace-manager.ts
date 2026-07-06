import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  getPairedProject,
  getPairedTaskById,
  getPairedWorkspace,
  upsertPairedWorkspace,
} from './db.js';
import { resolvePairedTaskWorkspacePath } from './group-folder.js';
import { logger } from './logger.js';
import { transitionPairedTaskStatus } from './paired-task-status.js';
import {
  branchRefName,
  buildOwnerBranchName,
  ensureBranchNotCheckedOutElsewhere,
  ensureGitRepository,
  isGitWorktreeClean,
  repairOwnerWorktreeRegistration,
  resolveBranchName,
  resolveCommit,
  runGit,
} from './paired-workspace-manager-git.js';
import {
  applyReviewerSparseCheckout,
  buildReviewerSnapshotFingerprint,
  configureReviewerGitIsolation,
  copySnapshotPaths,
  listAllowedTrackedFiles,
  listAllowedUntrackedFiles,
  listDeletedTrackedFiles,
  listReviewableTrackedDiffFiles,
  removeSnapshotPaths,
} from './paired-workspace-manager-snapshot.js';
import type { PairedTask, PairedWorkspace } from './types.js';
import { ensureWorkspaceDependenciesInstalled } from './workspace-package-manager.js';

const REVIEWER_SNAPSHOT_NOT_READY_BLOCK_MESSAGE =
  'Review workspace is not ready yet. Wait for the owner to complete a turn so the reviewer workspace can be prepared.';

export class OwnerWorkspaceRepairNeededError extends Error {
  readonly blockMessage: string;

  constructor(blockMessage: string) {
    super(blockMessage);
    this.name = 'OwnerWorkspaceRepairNeededError';
    this.blockMessage = blockMessage;
  }
}

export function isOwnerWorkspaceRepairNeededError(
  error: unknown,
): error is OwnerWorkspaceRepairNeededError {
  return error instanceof OwnerWorkspaceRepairNeededError;
}

function buildOwnerReanchorBackupPrefix(targetBranch: string): string {
  const groupFolder = targetBranch.startsWith('codex/owner/')
    ? targetBranch.slice('codex/owner/'.length)
    : targetBranch.replace(/\//g, '-');
  return `backup/${groupFolder}`;
}

function buildOwnerReanchorBackupSuffix(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `${timestamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function reanchorNamedOwnerWorkspaceBranch(args: {
  canonicalWorkDir: string;
  workspaceDir: string;
  currentBranch: string;
  targetBranch: string;
  targetBranchCommit: string | null;
  currentHeadCommit: string;
  reason: string;
}): boolean {
  const {
    canonicalWorkDir,
    workspaceDir,
    currentBranch,
    targetBranch,
    targetBranchCommit,
    currentHeadCommit,
    reason,
  } = args;

  ensureBranchNotCheckedOutElsewhere(
    canonicalWorkDir,
    workspaceDir,
    targetBranch,
  );

  const backupPrefix = buildOwnerReanchorBackupPrefix(targetBranch);
  const backupSuffix = buildOwnerReanchorBackupSuffix();
  const currentBackupBranch = `${backupPrefix}-current-pre-reanchor-${backupSuffix}`;
  const targetBackupBranch = `${backupPrefix}-target-pre-reanchor-${backupSuffix}`;

  runGit(['branch', currentBackupBranch, currentBranch], workspaceDir);
  if (targetBranchCommit) {
    runGit(['branch', targetBackupBranch, targetBranch], workspaceDir);
  }
  runGit(['branch', '-f', targetBranch, currentHeadCommit], workspaceDir);
  runGit(['symbolic-ref', 'HEAD', branchRefName(targetBranch)], workspaceDir);

  logger.warn(
    {
      workspaceDir,
      previousBranch: currentBranch,
      targetBranch,
      currentHeadCommit,
      targetBranchCommit,
      currentBackupBranch,
      targetBackupBranch: targetBranchCommit ? targetBackupBranch : null,
      reason,
    },
    'Re-anchored owner workspace branch mismatch while preserving worktree state',
  );
  return true;
}

function maybeRepairNamedOwnerWorkspaceBranch(args: {
  canonicalWorkDir: string;
  workspaceDir: string;
  currentBranch: string;
  targetBranch: string;
  targetBranchCommit: string | null;
}): boolean {
  const {
    canonicalWorkDir,
    workspaceDir,
    currentBranch,
    targetBranch,
    targetBranchCommit,
  } = args;
  const currentHeadCommit = resolveCommit(workspaceDir, 'HEAD');
  if (!currentHeadCommit) {
    throw new Error(
      `Unable to resolve owner workspace HEAD for ${workspaceDir}.`,
    );
  }

  if (!isGitWorktreeClean(workspaceDir)) {
    return reanchorNamedOwnerWorkspaceBranch({
      canonicalWorkDir,
      workspaceDir,
      currentBranch,
      targetBranch,
      targetBranchCommit,
      currentHeadCommit,
      reason: 'workspace has local changes',
    });
  }

  if (!targetBranchCommit) {
    return reanchorNamedOwnerWorkspaceBranch({
      canonicalWorkDir,
      workspaceDir,
      currentBranch,
      targetBranch,
      targetBranchCommit,
      currentHeadCommit,
      reason: 'expected branch does not exist yet',
    });
  }

  if (targetBranchCommit !== currentHeadCommit) {
    return reanchorNamedOwnerWorkspaceBranch({
      canonicalWorkDir,
      workspaceDir,
      currentBranch,
      targetBranch,
      targetBranchCommit,
      currentHeadCommit,
      reason: 'expected branch points at a different commit',
    });
  }

  ensureBranchNotCheckedOutElsewhere(
    canonicalWorkDir,
    workspaceDir,
    targetBranch,
  );
  runGit(['switch', targetBranch], workspaceDir);
  return true;
}

function getTaskAndProject(taskId: string): {
  task: PairedTask;
  canonicalWorkDir: string;
} {
  const task = getPairedTaskById(taskId);
  if (!task) {
    throw new Error(`Paired task not found: ${taskId}`);
  }

  const project = getPairedProject(task.chat_jid);
  if (!project) {
    throw new Error(`Paired project not found for chat: ${task.chat_jid}`);
  }

  return { task, canonicalWorkDir: project.canonical_work_dir };
}

function makeWorkspaceRecord(args: {
  taskId: string;
  role: PairedWorkspace['role'];
  workspaceDir: string;
  snapshotSourceDir?: string | null;
  snapshotSourceFingerprint?: string | null;
  snapshotRefreshedAt?: string | null;
  status?: PairedWorkspace['status'];
  createdAt?: string;
}): PairedWorkspace {
  const existing = getPairedWorkspace(args.taskId, args.role);
  const now = new Date().toISOString();
  return {
    id: existing?.id || `${args.taskId}:${args.role}`,
    task_id: args.taskId,
    role: args.role,
    workspace_dir: args.workspaceDir,
    snapshot_source_dir:
      args.snapshotSourceDir ?? existing?.snapshot_source_dir ?? null,
    snapshot_ref:
      args.snapshotSourceFingerprint ?? existing?.snapshot_ref ?? null,
    status: args.status ?? 'ready',
    snapshot_refreshed_at:
      args.snapshotRefreshedAt ?? existing?.snapshot_refreshed_at ?? null,
    created_at: existing?.created_at || args.createdAt || now,
    updated_at: now,
  };
}

export function resolvePairedTaskSourceFingerprint(
  taskId: string,
): string | null {
  const { task } = getTaskAndProject(taskId);
  const ownerWorkspace = getPairedWorkspace(taskId, 'owner');
  if (!ownerWorkspace) {
    return task.source_ref || null;
  }

  ensureGitRepository(ownerWorkspace.workspace_dir);
  return buildReviewerSnapshotFingerprint({
    sourceDir: ownerWorkspace.workspace_dir,
    allowedTrackedFiles: listAllowedTrackedFiles(ownerWorkspace.workspace_dir),
    deletedTrackedFiles: listDeletedTrackedFiles(ownerWorkspace.workspace_dir),
    allowedUntrackedFiles: listAllowedUntrackedFiles(
      ownerWorkspace.workspace_dir,
    ),
  });
}

export function hasReviewableOwnerWorkspaceChanges(taskId: string): boolean {
  const { task } = getTaskAndProject(taskId);
  const ownerWorkspace = getPairedWorkspace(taskId, 'owner');
  if (!ownerWorkspace) {
    return false;
  }

  ensureGitRepository(ownerWorkspace.workspace_dir);
  const reviewableTrackedDiffs = listReviewableTrackedDiffFiles(
    ownerWorkspace.workspace_dir,
    task.source_ref || 'HEAD',
  );
  if (reviewableTrackedDiffs.length > 0) {
    return true;
  }

  return listAllowedUntrackedFiles(ownerWorkspace.workspace_dir).length > 0;
}

/**
 * Register the canonical project directory as the owner workspace.
 * No worktree is created — the owner works directly on the live project.
 * This preserves the Claude SDK session across tasks (same project path).
 */
export function registerOwnerCanonicalWorkspace(
  taskId: string,
  canonicalWorkDir: string,
): PairedWorkspace {
  ensureGitRepository(canonicalWorkDir);
  const installResult = ensureWorkspaceDependenciesInstalled(canonicalWorkDir);
  if (installResult.installed) {
    logger.info(
      {
        taskId,
        workspaceDir: canonicalWorkDir,
        packageManager: installResult.packageManager,
        command: installResult.commandText ?? null,
      },
      'Installed owner workspace dependencies',
    );
  }
  const workspace = makeWorkspaceRecord({
    taskId,
    role: 'owner',
    workspaceDir: canonicalWorkDir,
  });
  upsertPairedWorkspace(workspace);
  return workspace;
}

export function provisionOwnerWorkspaceForPairedTask(
  taskId: string,
): PairedWorkspace {
  const { task, canonicalWorkDir } = getTaskAndProject(taskId);
  ensureGitRepository(canonicalWorkDir);
  const targetBranch = buildOwnerBranchName(task.group_folder);
  const canonicalHeadCommit = resolveCommit(canonicalWorkDir, 'HEAD');
  if (!canonicalHeadCommit) {
    throw new Error(
      `Unable to resolve canonical HEAD for owner workspace task ${taskId}.`,
    );
  }

  // Use a stable per-channel path (not per-task) so the Claude SDK
  // recognizes it as the same project across tasks → session persists.
  const workspacesBaseDir = path.resolve(DATA_DIR, 'workspaces');
  const workspaceDir = path.resolve(
    workspacesBaseDir,
    task.group_folder,
    'owner',
  );
  fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
  repairOwnerWorktreeRegistration(workspaceDir, canonicalWorkDir);

  const workspaceGitPath = path.join(workspaceDir, '.git');
  const targetBranchCommit = resolveCommit(
    canonicalWorkDir,
    branchRefName(targetBranch),
  );

  if (!fs.existsSync(workspaceGitPath)) {
    if (targetBranchCommit) {
      ensureBranchNotCheckedOutElsewhere(
        canonicalWorkDir,
        workspaceDir,
        targetBranch,
      );
      runGit(['worktree', 'add', workspaceDir, targetBranch], canonicalWorkDir);
    } else {
      runGit(
        [
          'worktree',
          'add',
          '-b',
          targetBranch,
          workspaceDir,
          canonicalHeadCommit,
        ],
        canonicalWorkDir,
      );
    }
    logger.info(
      {
        taskId,
        workspaceDir,
        targetBranch,
        baseRef: canonicalHeadCommit,
        sourceRef: task.source_ref,
      },
      'Provisioned stable owner workspace branch for channel',
    );
  } else {
    ensureGitRepository(workspaceDir);

    const currentBranch = resolveBranchName(workspaceDir);
    if (currentBranch === targetBranch) {
      // Stable owner workspace is already attached to the channel branch.
    } else if (currentBranch) {
      const repaired = maybeRepairNamedOwnerWorkspaceBranch({
        canonicalWorkDir,
        workspaceDir,
        currentBranch,
        targetBranch,
        targetBranchCommit,
      });
      if (repaired) {
        logger.warn(
          {
            taskId,
            workspaceDir,
            previousBranch: currentBranch,
            targetBranch,
            targetBranchCommit,
          },
          'Auto-repaired owner workspace branch mismatch',
        );
      }
    } else {
      const currentHeadCommit = resolveCommit(workspaceDir, 'HEAD');
      if (!currentHeadCommit) {
        throw new Error(
          `Unable to resolve detached owner workspace HEAD for ${workspaceDir}.`,
        );
      }

      if (!targetBranchCommit) {
        runGit(['switch', '-c', targetBranch], workspaceDir);
      } else if (targetBranchCommit === currentHeadCommit) {
        ensureBranchNotCheckedOutElsewhere(
          canonicalWorkDir,
          workspaceDir,
          targetBranch,
        );
        runGit(['switch', targetBranch], workspaceDir);
      } else {
        throw new Error(
          `Owner workspace ${workspaceDir} is detached at ${currentHeadCommit}, but ${targetBranch} points to ${targetBranchCommit}.`,
        );
      }
    }
  }

  const installResult = ensureWorkspaceDependenciesInstalled(workspaceDir);
  if (installResult.installed) {
    logger.info(
      {
        taskId,
        workspaceDir,
        packageManager: installResult.packageManager,
        command: installResult.commandText ?? null,
      },
      'Installed owner workspace dependencies',
    );
  }

  const workspace = makeWorkspaceRecord({
    taskId,
    role: 'owner',
    workspaceDir,
  });
  upsertPairedWorkspace(workspace);
  return workspace;
}

export function refreshReviewerSnapshotForPairedTask(
  taskId: string,
): PairedWorkspace {
  const ownerWorkspace = getPairedWorkspace(taskId, 'owner');
  if (!ownerWorkspace) {
    throw new Error(
      `Owner workspace is not available for paired task ${taskId}.`,
    );
  }
  ensureGitRepository(ownerWorkspace.workspace_dir);

  const { task } = getTaskAndProject(taskId);
  const reviewerDir = resolvePairedTaskWorkspacePath(
    task.group_folder,
    task.id,
    'reviewer',
  );
  fs.mkdirSync(path.dirname(reviewerDir), { recursive: true });

  if (!fs.existsSync(path.join(reviewerDir, '.git'))) {
    fs.rmSync(reviewerDir, { recursive: true, force: true });
    runGit(['clone', '--shared', ownerWorkspace.workspace_dir, reviewerDir]);
  }

  const allowedTrackedFiles = listAllowedTrackedFiles(
    ownerWorkspace.workspace_dir,
  );
  const deletedTrackedFiles = listDeletedTrackedFiles(
    ownerWorkspace.workspace_dir,
  );
  const allowedUntrackedFiles = listAllowedUntrackedFiles(
    ownerWorkspace.workspace_dir,
  );
  const snapshotFingerprint = buildReviewerSnapshotFingerprint({
    sourceDir: ownerWorkspace.workspace_dir,
    allowedTrackedFiles,
    deletedTrackedFiles,
    allowedUntrackedFiles,
  });

  runGit(['reset', '--hard', 'HEAD'], reviewerDir);
  runGit(['clean', '-fdx'], reviewerDir);
  applyReviewerSparseCheckout(reviewerDir, allowedTrackedFiles);
  copySnapshotPaths(
    ownerWorkspace.workspace_dir,
    reviewerDir,
    allowedTrackedFiles,
  );
  removeSnapshotPaths(reviewerDir, deletedTrackedFiles);
  copySnapshotPaths(
    ownerWorkspace.workspace_dir,
    reviewerDir,
    allowedUntrackedFiles,
  );
  configureReviewerGitIsolation(reviewerDir);

  const refreshedAt = new Date().toISOString();
  const workspace = makeWorkspaceRecord({
    taskId,
    role: 'reviewer',
    workspaceDir: reviewerDir,
    snapshotSourceDir: ownerWorkspace.workspace_dir,
    snapshotSourceFingerprint: snapshotFingerprint,
    snapshotRefreshedAt: refreshedAt,
  });
  upsertPairedWorkspace(workspace);
  logger.info(
    { taskId, reviewerDir, snapshotSourceDir: ownerWorkspace.workspace_dir },
    'Refreshed reviewer snapshot for paired task',
  );
  return workspace;
}

export function markPairedTaskReviewReady(taskId: string): {
  ownerWorkspace: PairedWorkspace;
  reviewerWorkspace: PairedWorkspace;
} | null {
  const requestedAt = new Date().toISOString();

  const ownerWorkspace = getPairedWorkspace(taskId, 'owner');
  if (!ownerWorkspace) {
    return null;
  }

  const installResult = ensureWorkspaceDependenciesInstalled(
    ownerWorkspace.workspace_dir,
  );
  if (installResult.installed) {
    logger.info(
      {
        taskId,
        ownerDir: ownerWorkspace.workspace_dir,
        packageManager: installResult.packageManager,
        command: installResult.commandText ?? null,
      },
      'Installed owner workspace dependencies before review handoff',
    );
  }

  const reviewerWorkspace = syncReviewerWorkspaceToOwnerWorkspace({
    taskId,
    ownerWorkspace,
    syncedAt: requestedAt,
  });
  logger.info(
    { taskId, ownerDir: ownerWorkspace.workspace_dir },
    'Reviewer will mount owner workspace directly',
  );

  const task = getPairedTaskById(taskId);
  if (!task) {
    return null;
  }
  transitionPairedTaskStatus({
    taskId,
    currentStatus: task.status,
    nextStatus: 'review_ready',
    expectedUpdatedAt: task.updated_at,
    updatedAt: requestedAt,
    patch: {
      review_requested_at: requestedAt,
    },
  });

  return { ownerWorkspace, reviewerWorkspace };
}

export interface PreparedReviewerWorkspace {
  workspace: PairedWorkspace | null;
  blockMessage?: string;
  autoRefreshed: boolean;
}

function syncReviewerWorkspaceToOwnerWorkspace(args: {
  taskId: string;
  ownerWorkspace: PairedWorkspace;
  syncedAt?: string;
}): PairedWorkspace {
  const existingReviewerWorkspace = getPairedWorkspace(args.taskId, 'reviewer');
  if (
    existingReviewerWorkspace &&
    existingReviewerWorkspace.workspace_dir ===
      args.ownerWorkspace.workspace_dir &&
    existingReviewerWorkspace.snapshot_source_dir ===
      args.ownerWorkspace.workspace_dir
  ) {
    return existingReviewerWorkspace;
  }

  const reviewerWorkspace = makeWorkspaceRecord({
    taskId: args.taskId,
    role: 'reviewer',
    workspaceDir: args.ownerWorkspace.workspace_dir,
    snapshotSourceDir: args.ownerWorkspace.workspace_dir,
    snapshotRefreshedAt: args.syncedAt ?? new Date().toISOString(),
  });
  upsertPairedWorkspace(reviewerWorkspace);
  if (existingReviewerWorkspace) {
    logger.info(
      {
        taskId: args.taskId,
        previousReviewerDir: existingReviewerWorkspace.workspace_dir,
        ownerDir: args.ownerWorkspace.workspace_dir,
      },
      'Resynced reviewer workspace to the current owner workspace',
    );
  }
  return reviewerWorkspace;
}

export function prepareReviewerWorkspaceForExecution(
  task: PairedTask,
): PreparedReviewerWorkspace {
  const ownerWorkspace = getPairedWorkspace(task.id, 'owner') ?? null;
  if (!ownerWorkspace) {
    return {
      workspace: null,
      autoRefreshed: false,
      blockMessage: REVIEWER_SNAPSHOT_NOT_READY_BLOCK_MESSAGE,
    };
  }

  // Reviewer uses the owner workspace directly in read-only mode.
  // If an old reviewer record still points elsewhere, resync it first.
  const reviewerWorkspace = syncReviewerWorkspaceToOwnerWorkspace({
    taskId: task.id,
    ownerWorkspace,
  });
  return { workspace: reviewerWorkspace, autoRefreshed: false };
}
