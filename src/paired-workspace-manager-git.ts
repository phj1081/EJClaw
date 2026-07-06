import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export function runGit(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function runGitWithInput(
  args: string[],
  cwd: string,
  input: string,
): string {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function ensureGitRepository(repoDir: string): void {
  const insideWorkTree = runGit(
    ['rev-parse', '--is-inside-work-tree'],
    repoDir,
  );
  if (insideWorkTree !== 'true') {
    throw new Error(`Not a git repository: ${repoDir}`);
  }
}

export function isGitWorktreeClean(repoDir: string): boolean {
  return runGit(['status', '--short'], repoDir).length === 0;
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

export function branchRefName(branchName: string): string {
  return `refs/heads/${branchName}`;
}

export function buildOwnerBranchName(groupFolder: string): string {
  return `codex/owner/${groupFolder}`;
}

export function resolveBranchName(repoDir: string): string | null {
  return tryRunGit(['symbolic-ref', '--short', '-q', 'HEAD'], repoDir);
}

export function resolveCommit(repoDir: string, ref: string): string | null {
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

export function ensureBranchNotCheckedOutElsewhere(
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

export function repairOwnerWorktreeRegistration(
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

export function listGitPaths(repoDir: string, args: string[]): string[] {
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
