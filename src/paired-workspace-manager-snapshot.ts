import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import {
  listGitPaths,
  runGit,
  runGitWithInput,
} from './paired-workspace-manager-git.js';

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

export function listAllowedTrackedFiles(sourceDir: string): string[] {
  return listGitPaths(sourceDir, ['ls-files', '--cached', '-z']).filter(
    (relativePath) => !isReviewerSnapshotDeniedPath(relativePath),
  );
}

export function listDeletedTrackedFiles(sourceDir: string): string[] {
  return listGitPaths(sourceDir, ['ls-files', '--deleted', '-z']).filter(
    (relativePath) => !isReviewerSnapshotDeniedPath(relativePath),
  );
}

export function listAllowedUntrackedFiles(sourceDir: string): string[] {
  return listGitPaths(sourceDir, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]).filter(shouldIncludeUntrackedReviewerPath);
}

export function listReviewableTrackedDiffFiles(
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

export function copySnapshotPaths(
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

export function removeSnapshotPaths(
  targetDir: string,
  relativePaths: string[],
): void {
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    fs.rmSync(path.join(targetDir, relativePath), {
      recursive: true,
      force: true,
    });
  }
}

export function buildReviewerSnapshotFingerprint(args: {
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

export function applyReviewerSparseCheckout(
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

export function configureReviewerGitIsolation(workspaceDir: string): void {
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
