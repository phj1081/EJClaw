import { execFileSync } from 'child_process';
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
import type { PairedTask, PairedWorkspace } from './types.js';
import { ensureWorkspaceDependenciesInstalled } from './workspace-package-manager.js';

const REVIEWER_SNAPSHOT_NOT_READY_BLOCK_MESSAGE =
  'Review workspace is not ready yet. Wait for the owner to complete a turn so the reviewer workspace can be prepared.';
const REVIEWER_SNAPSHOT_DENY_SEGMENTS = new Set([
  '.git',
  '.claude',
  '.codex',
  '.next',
  '.turbo',
  '.cache',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'logs',
]);

const REVIEWER_SNAPSHOT_ALLOWED_UNTRACKED_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.csv',
  '.go',
  '.graphql',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.md',
  '.mjs',
  '.prisma',
  '.proto',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.svg',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

const REVIEWER_SNAPSHOT_ALLOWED_UNTRACKED_BASENAMES = new Set([
  '.editorconfig',
  '.eslintignore',
  '.eslintrc',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc',
  'Dockerfile',
  'Makefile',
  'README',
  'README.md',
  'package-lock.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'yarn.lock',
]);

function runGit(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runGitWithInput(args: string[], cwd: string, input: string): string {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

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

function ensureGitRepository(repoDir: string): void {
  const insideWorkTree = runGit(
    ['rev-parse', '--is-inside-work-tree'],
    repoDir,
  );
  if (insideWorkTree !== 'true') {
    throw new Error(`Not a git repository: ${repoDir}`);
  }
}

function isGitWorktreeClean(repoDir: string): boolean {
  return runGit(['status', '--short'], repoDir).length === 0;
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

type GitWorktreeEntry = {
  worktreePath: string;
  head: string | null;
  branchRef: string | null;
  detached: boolean;
  prunableReason: string | null;
};

function tryRunGit(args: string[], cwd?: string): string | null {
  try {
    return runGit(args, cwd);
  } catch {
    return null;
  }
}

function listGitWorktrees(repoDir: string): GitWorktreeEntry[] {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;

  const pushCurrent = () => {
    if (current) {
      entries.push(current);
      current = null;
    }
  };

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      pushCurrent();
      continue;
    }
    if (line.startsWith('worktree ')) {
      pushCurrent();
      current = {
        worktreePath: path.resolve(line.slice('worktree '.length).trim()),
        head: null,
        branchRef: null,
        detached: false,
        prunableReason: null,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
      continue;
    }
    if (line.startsWith('branch ')) {
      current.branchRef = line.slice('branch '.length).trim();
      continue;
    }
    if (line === 'detached') {
      current.detached = true;
      continue;
    }
    if (line.startsWith('prunable')) {
      current.prunableReason = line.slice('prunable'.length).trim() || null;
    }
  }
  pushCurrent();
  return entries;
}

function branchRefName(branchName: string): string {
  return `refs/heads/${branchName}`;
}

function buildOwnerBranchName(groupFolder: string): string {
  return `codex/owner/${groupFolder}`;
}

function resolveBranchName(repoDir: string): string | null {
  return tryRunGit(['symbolic-ref', '--short', '-q', 'HEAD'], repoDir);
}

function resolveCommit(repoDir: string, ref: string): string | null {
  return tryRunGit(['rev-parse', '--verify', `${ref}^{commit}`], repoDir);
}

function findWorktreeEntry(
  repoDir: string,
  workspaceDir: string,
): GitWorktreeEntry | null {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  return (
    listGitWorktrees(repoDir).find(
      (entry) => path.resolve(entry.worktreePath) === resolvedWorkspaceDir,
    ) ?? null
  );
}

function ensureBranchNotCheckedOutElsewhere(
  canonicalWorkDir: string,
  workspaceDir: string,
  branchName: string,
): void {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const targetBranchRef = branchRefName(branchName);
  const conflictingWorktree = listGitWorktrees(canonicalWorkDir).find(
    (entry) =>
      entry.branchRef === targetBranchRef &&
      path.resolve(entry.worktreePath) !== resolvedWorkspaceDir,
  );
  if (conflictingWorktree) {
    throw new Error(
      `Owner branch ${branchName} is already checked out at ${conflictingWorktree.worktreePath}.`,
    );
  }
}

function repairOwnerWorktreeRegistration(
  workspaceDir: string,
  canonicalWorkDir: string,
): void {
  runGit(['worktree', 'prune', '--expire', 'now'], canonicalWorkDir);

  const entry = findWorktreeEntry(canonicalWorkDir, workspaceDir);
  if (!entry) {
    return;
  }

  const workspaceExists = fs.existsSync(workspaceDir);
  if (!workspaceExists || entry.prunableReason) {
    throw new Error(
      `Owner workspace registration for ${workspaceDir} is stale after repair: ${entry.prunableReason ?? 'missing worktree path'}.`,
    );
  }
}

function listGitPaths(repoDir: string, args: string[]): string[] {
  const output = execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output
    .split('\0')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isReviewerSnapshotDeniedPath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (
    segments.some((segment) => REVIEWER_SNAPSHOT_DENY_SEGMENTS.has(segment))
  ) {
    return true;
  }

  const basename = path.basename(relativePath);
  if (basename === '.env') {
    return true;
  }
  if (
    basename.startsWith('.env.') &&
    basename !== '.env.example' &&
    basename !== '.env.sample'
  ) {
    return true;
  }
  if (basename.endsWith('.log')) {
    return true;
  }

  return false;
}

function shouldIncludeUntrackedReviewerPath(relativePath: string): boolean {
  if (isReviewerSnapshotDeniedPath(relativePath)) {
    return false;
  }

  const basename = path.basename(relativePath);
  if (REVIEWER_SNAPSHOT_ALLOWED_UNTRACKED_BASENAMES.has(basename)) {
    return true;
  }

  return REVIEWER_SNAPSHOT_ALLOWED_UNTRACKED_EXTENSIONS.has(
    path.extname(basename).toLowerCase(),
  );
}

function listAllowedTrackedFiles(sourceDir: string): string[] {
  return listGitPaths(sourceDir, ['ls-files', '--cached', '-z']).filter(
    (relativePath) => !isReviewerSnapshotDeniedPath(relativePath),
  );
}

function listDeletedTrackedFiles(sourceDir: string): string[] {
  return listGitPaths(sourceDir, ['ls-files', '--deleted', '-z']).filter(
    (relativePath) => !isReviewerSnapshotDeniedPath(relativePath),
  );
}

function listAllowedUntrackedFiles(sourceDir: string): string[] {
  return listGitPaths(sourceDir, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]).filter(shouldIncludeUntrackedReviewerPath);
}

function listReviewableTrackedDiffFiles(
  sourceDir: string,
  sourceRef: string,
): string[] {
  return listGitPaths(sourceDir, [
    'diff',
    '--name-only',
    '-z',
    sourceRef,
    '--',
  ]).filter((relativePath) => !isReviewerSnapshotDeniedPath(relativePath));
}

function copySnapshotPaths(
  sourceDir: string,
  targetDir: string,
  relativePaths: string[],
): void {
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    const sourcePath = path.join(sourceDir, relativePath);
    if (!fs.existsSync(sourcePath)) continue;

    const targetPath = path.join(targetDir, relativePath);
    const srcStat = fs.statSync(sourcePath);
    // When source is a directory (e.g. nested git repo listed by git ls-files),
    // remove any conflicting non-directory at the target before copying.
    if (srcStat.isDirectory()) {
      if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) {
        fs.rmSync(targetPath, { force: true });
      }
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.cpSync(sourcePath, targetPath, { force: true, recursive: true });
  }
}

function removeSnapshotPaths(targetDir: string, relativePaths: string[]): void {
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    fs.rmSync(path.join(targetDir, relativePath), {
      recursive: true,
      force: true,
    });
  }
}

function buildReviewerSnapshotFingerprint(args: {
  sourceDir: string;
  allowedTrackedFiles: string[];
  deletedTrackedFiles: string[];
  allowedUntrackedFiles: string[];
}): string {
  const hash = crypto.createHash('sha256');
  const appendFile = (kind: 'tracked' | 'untracked', relativePath: string) => {
    const sourcePath = path.join(args.sourceDir, relativePath);
    if (!fs.existsSync(sourcePath)) return;
    // Skip directories (e.g. submodules listed by git ls-files)
    try {
      if (fs.statSync(sourcePath).isDirectory()) return;
    } catch {
      return;
    }
    hash.update(`${kind}\0${relativePath}\0`);
    hash.update(fs.readFileSync(sourcePath));
    hash.update('\0');
  };

  for (const relativePath of [...new Set(args.allowedTrackedFiles)].sort()) {
    appendFile('tracked', relativePath);
  }
  for (const relativePath of [...new Set(args.deletedTrackedFiles)].sort()) {
    hash.update(`deleted\0${relativePath}\0`);
  }
  for (const relativePath of [...new Set(args.allowedUntrackedFiles)].sort()) {
    appendFile('untracked', relativePath);
  }

  return hash.digest('hex');
}

function applyReviewerSparseCheckout(
  reviewerDir: string,
  allowedTrackedFiles: string[],
): void {
  runGit(['sparse-checkout', 'init', '--no-cone'], reviewerDir);
  const patterns =
    allowedTrackedFiles.length > 0
      ? `${allowedTrackedFiles.join('\n')}\n`
      : '/*\n!/*\n';
  runGitWithInput(
    ['sparse-checkout', 'set', '--no-cone', '--stdin'],
    reviewerDir,
    patterns,
  );
}

function configureReviewerGitIsolation(workspaceDir: string): void {
  try {
    runGit(['config', '--local', 'push.default', 'nothing'], workspaceDir);
    runGit(['config', '--local', 'credential.helper', ''], workspaceDir);
    runGit(
      ['config', '--local', 'remote.origin.pushurl', 'DISABLED_BY_EJCLAW'],
      workspaceDir,
    );
  } catch (error) {
    logger.warn(
      { workspaceDir, error },
      'Failed to apply reviewer git isolation settings',
    );
  }
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
