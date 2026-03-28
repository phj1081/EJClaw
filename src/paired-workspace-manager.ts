import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  getPairedProject,
  getPairedTaskById,
  getPairedWorkspace,
  updatePairedTask,
  upsertPairedWorkspace,
} from './db.js';
import { resolvePairedTaskWorkspacePath } from './group-folder.js';
import { logger } from './logger.js';
import type { PairedTask, PairedWorkspace } from './types.js';

const REVIEWER_SNAPSHOT_STALE_BLOCK_MESSAGE =
  'Review snapshot is stale after owner changes. Retry the review once to refresh against the latest owner workspace.';
const REVIEWER_SNAPSHOT_NOT_READY_BLOCK_MESSAGE =
  'Review snapshot is not ready yet. Ask the owner to run /review (or /review-ready) after preparing changes.';
export const PLAN_REVIEW_REQUIRED_BLOCK_MESSAGE =
  'Plan review is required before formal review for this high-risk task.';

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

function ensureGitRepository(repoDir: string): void {
  const insideWorkTree = runGit(
    ['rev-parse', '--is-inside-work-tree'],
    repoDir,
  );
  if (insideWorkTree !== 'true') {
    throw new Error(`Not a git repository: ${repoDir}`);
  }
}

function ensureCleanDirectory(targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
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

function copySnapshotPaths(
  sourceDir: string,
  targetDir: string,
  relativePaths: string[],
): void {
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    const sourcePath = path.join(sourceDir, relativePath);
    if (!fs.existsSync(sourcePath)) continue;

    const targetPath = path.join(targetDir, relativePath);
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
    snapshot_source_fingerprint:
      args.snapshotSourceFingerprint ??
      existing?.snapshot_source_fingerprint ??
      null,
    status: args.status ?? 'ready',
    snapshot_refreshed_at:
      args.snapshotRefreshedAt ?? existing?.snapshot_refreshed_at ?? null,
    created_at: existing?.created_at || args.createdAt || now,
    updated_at: now,
  };
}

export function resolvePairedTaskSourceFingerprint(taskId: string): string | null {
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

export function provisionOwnerWorkspaceForPairedTask(
  taskId: string,
): PairedWorkspace {
  const { task, canonicalWorkDir } = getTaskAndProject(taskId);
  ensureGitRepository(canonicalWorkDir);

  const sourceRef = task.source_ref || 'HEAD';
  const workspaceDir = resolvePairedTaskWorkspacePath(
    task.group_folder,
    task.id,
    'owner',
  );
  const parentDir = path.dirname(workspaceDir);
  fs.mkdirSync(parentDir, { recursive: true });

  if (!fs.existsSync(path.join(workspaceDir, '.git'))) {
    ensureCleanDirectory(parentDir);
    runGit(
      ['worktree', 'add', '--detach', workspaceDir, sourceRef],
      canonicalWorkDir,
    );
    logger.info(
      { taskId, workspaceDir, sourceRef },
      'Provisioned owner workspace for paired task',
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
  updatePairedTask(taskId, {
    status: 'review_pending',
    review_requested_at: requestedAt,
    updated_at: requestedAt,
  });

  const ownerWorkspace = getPairedWorkspace(taskId, 'owner');
  if (!ownerWorkspace) {
    return null;
  }
  const reviewerWorkspace = refreshReviewerSnapshotForPairedTask(taskId);
  const now = new Date().toISOString();

  updatePairedTask(taskId, {
    status: 'review_ready',
    updated_at: now,
  });

  return { ownerWorkspace, reviewerWorkspace };
}

export interface PreparedReviewerWorkspace {
  workspace: PairedWorkspace | null;
  blockMessage?: string;
  autoRefreshed: boolean;
}

export function prepareReviewerWorkspaceForExecution(
  task: PairedTask,
): PreparedReviewerWorkspace {
  if (task.risk_level === 'high' && task.plan_status !== 'approved') {
    return {
      workspace: null,
      autoRefreshed: false,
      blockMessage: PLAN_REVIEW_REQUIRED_BLOCK_MESSAGE,
    };
  }

  const ownerWorkspace = getPairedWorkspace(task.id, 'owner') ?? null;
  if (!ownerWorkspace) {
    return {
      workspace: null,
      autoRefreshed: false,
      blockMessage: REVIEWER_SNAPSHOT_NOT_READY_BLOCK_MESSAGE,
    };
  }
  const reviewerWorkspace = getPairedWorkspace(task.id, 'reviewer') ?? null;
  const allowedTrackedFiles = listAllowedTrackedFiles(
    ownerWorkspace.workspace_dir,
  );
  const deletedTrackedFiles = listDeletedTrackedFiles(
    ownerWorkspace.workspace_dir,
  );
  const allowedUntrackedFiles = listAllowedUntrackedFiles(
    ownerWorkspace.workspace_dir,
  );
  const currentFingerprint = buildReviewerSnapshotFingerprint({
    sourceDir: ownerWorkspace.workspace_dir,
    allowedTrackedFiles,
    deletedTrackedFiles,
    allowedUntrackedFiles,
  });
  const snapshotMissing =
    !reviewerWorkspace?.snapshot_refreshed_at || !reviewerWorkspace;
  const snapshotStale =
    !!reviewerWorkspace &&
    (reviewerWorkspace.status === 'stale' ||
      reviewerWorkspace.snapshot_source_fingerprint !== currentFingerprint);
  const now = new Date().toISOString();

  if (snapshotMissing || snapshotStale) {
    if (task.status === 'review_pending' || task.status === 'review_ready') {
      const refreshedWorkspace = refreshReviewerSnapshotForPairedTask(task.id);
      updatePairedTask(task.id, {
        status: 'review_ready',
        updated_at: now,
      });
      return {
        workspace: refreshedWorkspace,
        autoRefreshed: true,
      };
    }

    if (snapshotMissing) {
      return {
        workspace: null,
        autoRefreshed: false,
        blockMessage: REVIEWER_SNAPSHOT_NOT_READY_BLOCK_MESSAGE,
      };
    }

    if (reviewerWorkspace) {
      upsertPairedWorkspace(
        makeWorkspaceRecord({
          taskId: task.id,
          role: 'reviewer',
          workspaceDir: reviewerWorkspace.workspace_dir,
          snapshotSourceDir: reviewerWorkspace.snapshot_source_dir,
          snapshotSourceFingerprint:
            reviewerWorkspace.snapshot_source_fingerprint,
          snapshotRefreshedAt: reviewerWorkspace.snapshot_refreshed_at,
          status: 'stale',
          createdAt: reviewerWorkspace.created_at,
        }),
      );
    }
    updatePairedTask(task.id, {
      status: 'review_pending',
      updated_at: now,
    });
    return {
      workspace: null,
      autoRefreshed: false,
      blockMessage: REVIEWER_SNAPSHOT_STALE_BLOCK_MESSAGE,
    };
  }

  return {
    workspace: reviewerWorkspace,
    autoRefreshed: false,
  };
}
