import { execFileSync } from 'child_process';
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

function resetDirectoryExceptGit(targetDir: string): void {
  if (!fs.existsSync(targetDir)) return;
  for (const entry of fs.readdirSync(targetDir)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
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

function copySelectedSnapshotTree(sourceDir: string, targetDir: string): void {
  resetDirectoryExceptGit(targetDir);

  const trackedFiles = listGitPaths(sourceDir, [
    'ls-files',
    '--cached',
    '-z',
  ]).filter((relativePath) => !isReviewerSnapshotDeniedPath(relativePath));
  const untrackedFiles = listGitPaths(sourceDir, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]).filter(shouldIncludeUntrackedReviewerPath);

  const filesToCopy = [...new Set([...trackedFiles, ...untrackedFiles])].sort();

  for (const relativePath of filesToCopy) {
    const sourcePath = path.join(sourceDir, relativePath);
    if (!fs.existsSync(sourcePath)) continue;

    const targetPath = path.join(targetDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.cpSync(sourcePath, targetPath, { force: true, recursive: true });
  }
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
  snapshotRefreshedAt?: string | null;
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
    status: 'ready',
    snapshot_refreshed_at:
      args.snapshotRefreshedAt ?? existing?.snapshot_refreshed_at ?? null,
    created_at: existing?.created_at || args.createdAt || now,
    updated_at: now,
  };
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
  const ownerWorkspace = provisionOwnerWorkspaceForPairedTask(taskId);
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

  runGit(['reset', '--hard', 'HEAD'], reviewerDir);
  runGit(['clean', '-fdx'], reviewerDir);
  copySelectedSnapshotTree(ownerWorkspace.workspace_dir, reviewerDir);
  configureReviewerGitIsolation(reviewerDir);

  const refreshedAt = new Date().toISOString();
  const workspace = makeWorkspaceRecord({
    taskId,
    role: 'reviewer',
    workspaceDir: reviewerDir,
    snapshotSourceDir: ownerWorkspace.workspace_dir,
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
} {
  const ownerWorkspace = provisionOwnerWorkspaceForPairedTask(taskId);
  const reviewerWorkspace = refreshReviewerSnapshotForPairedTask(taskId);
  const now = new Date().toISOString();

  updatePairedTask(taskId, {
    status: 'review_ready',
    review_requested_at: now,
    updated_at: now,
  });

  return { ownerWorkspace, reviewerWorkspace };
}
