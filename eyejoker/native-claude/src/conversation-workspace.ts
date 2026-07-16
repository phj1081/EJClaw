import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  utimesSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { KeyedSerialQueue } from "./keyed-serial-queue";
import type { JobRecord, RouteConfig } from "./types";

const execFileAsync = promisify(execFile);

function safeSegment(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "conversation";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${slug}-${hash}`;
}

export function conversationWorkspacePath(
  workspaceRoot: string,
  repositoryIdentity: string,
  routeId: string,
  identity: string,
): string {
  return join(
    workspaceRoot,
    safeSegment(repositoryIdentity),
    safeSegment(routeId),
    safeSegment(identity),
  );
}

export function conversationLockKey(route: RouteConfig, conversationKey: string): string {
  return route.conversationWorktrees ? conversationKey : (route.lockKey ?? route.cwd);
}

async function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout.trim();
}

function workspaceRestoreRef(workspacePath: string): string {
  return `refs/claude-native/workspaces/${safeSegment(resolve(workspacePath))}`;
}

function absoluteGitPath(worktreePath: string, rawPath: string): string {
  return realpathSync(resolve(worktreePath, rawPath));
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

interface WorktreeEntry {
  path: string;
  locked: boolean;
}

function parseWorktreeEntries(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const token of output.split("\0")) {
    if (token.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: token.slice("worktree ".length), locked: false };
    } else if (token === "locked" || token.startsWith("locked ")) {
      if (current) current.locked = true;
    } else if (token === "" && current) {
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

interface ManagedCandidate {
  path: string;
  repositoryBucket: string;
  lastUsedMs: number;
}

export interface WorkspacePrepareOptions {
  workspacePath?: string;
  identity?: string;
  baseRef?: string;
}

export interface WorkspaceCleanupOptions {
  protectedPaths?: Iterable<string>;
  ttlMs?: number;
  maxTotal?: number;
  maxPerRepository?: number;
  nowMs?: number;
  beforeRemove?: (path: string, revision: string) => void | Promise<void>;
  afterRemove?: (path: string) => void | Promise<void>;
}

export interface WorkspaceCleanupResult {
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
}

export class ConversationWorkspaceManager {
  private readonly repositoryQueue = new KeyedSerialQueue();
  private readonly workspaceRoot: string;
  private readonly defaultMaxTotal: number;
  private readonly defaultMaxPerRepository: number;

  constructor(
    workspaceRoot: string,
    private readonly gitTimeoutMs = 120_000,
    limits: { maxTotal?: number; maxPerRepository?: number } = {},
  ) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.defaultMaxTotal = limits.maxTotal ?? 256;
    this.defaultMaxPerRepository = limits.maxPerRepository ?? 64;
    mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
  }

  private async repositoryIdentity(route: RouteConfig): Promise<{ commonDir: string; routeRoot: string }> {
    const commonDirRaw = await git(
      route.cwd,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      this.gitTimeoutMs,
    );
    const routeRootRaw = await git(route.cwd, ["rev-parse", "--show-toplevel"], this.gitTimeoutMs);
    return {
      commonDir: absoluteGitPath(route.cwd, commonDirRaw),
      routeRoot: realpathSync(routeRootRaw),
    };
  }

  private async registeredWorktrees(cwd: string): Promise<WorktreeEntry[]> {
    return parseWorktreeEntries(await git(cwd, ["worktree", "list", "--porcelain", "-z"], this.gitTimeoutMs));
  }

  private assertManagedPath(path: string): void {
    const absolute = resolve(path);
    if (!isWithin(this.workspaceRoot, absolute) || absolute === this.workspaceRoot) {
      throw new Error(`workspace escapes managed root: ${path}`);
    }
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`workspace path is a symlink: ${absolute}`);
    if (!info.isDirectory()) throw new Error(`workspace path is not a directory: ${absolute}`);
    if (realpathSync(absolute) !== absolute) throw new Error(`workspace path is not canonical: ${absolute}`);
  }

  async validate(route: RouteConfig, workspacePath: string): Promise<void> {
    this.assertManagedPath(workspacePath);
    const expected = await this.repositoryIdentity(route);
    const topLevel = realpathSync(await git(workspacePath, ["rev-parse", "--show-toplevel"], this.gitTimeoutMs));
    if (topLevel !== resolve(workspacePath)) {
      throw new Error(`workspace is not an exact Git top-level: ${workspacePath}`);
    }
    const existingCommonRaw = await git(
      workspacePath,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      this.gitTimeoutMs,
    );
    const existingCommon = absoluteGitPath(workspacePath, existingCommonRaw);
    if (existingCommon !== expected.commonDir) {
      throw new Error(`workspace path belongs to another repository: ${workspacePath}`);
    }
    const registered = await this.registeredWorktrees(expected.routeRoot);
    if (!registered.some((entry) => resolve(entry.path) === resolve(workspacePath))) {
      throw new Error(`workspace is not registered in git worktree metadata: ${workspacePath}`);
    }
  }

  private listManagedCandidates(): ManagedCandidate[] {
    if (!existsSync(this.workspaceRoot)) return [];
    const candidates: ManagedCandidate[] = [];
    for (const repository of readdirSync(this.workspaceRoot, { withFileTypes: true })) {
      if (!repository.isDirectory() || repository.isSymbolicLink()) continue;
      const repositoryPath = join(this.workspaceRoot, repository.name);
      for (const route of readdirSync(repositoryPath, { withFileTypes: true })) {
        if (!route.isDirectory() || route.isSymbolicLink()) continue;
        const routePath = join(repositoryPath, route.name);
        for (const conversation of readdirSync(routePath, { withFileTypes: true })) {
          if (!conversation.isDirectory() || conversation.isSymbolicLink()) continue;
          const path = join(routePath, conversation.name);
          candidates.push({
            path,
            repositoryBucket: repository.name,
            lastUsedMs: statSync(path).mtimeMs,
          });
        }
      }
    }
    return candidates;
  }

  private assertCapacity(repositoryBucket: string, workspacePath: string): void {
    if (existsSync(workspacePath)) return;
    const candidates = this.listManagedCandidates();
    const repositoryCount = candidates.filter((candidate) => candidate.repositoryBucket === repositoryBucket).length;
    if (candidates.length >= this.defaultMaxTotal) {
      throw new Error(`managed worktree global quota reached (${this.defaultMaxTotal})`);
    }
    if (repositoryCount >= this.defaultMaxPerRepository) {
      throw new Error(`managed worktree repository quota reached (${this.defaultMaxPerRepository})`);
    }
  }

  isManagedWorkspacePath(path: string): boolean {
    const candidate = resolve(path);
    const relativePath = relative(this.workspaceRoot, candidate);
    return Boolean(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
  }

  async captureCleanRevision(route: RouteConfig, workspacePath: string): Promise<string> {
    const repository = await this.repositoryIdentity(route);
    return this.repositoryQueue.run(repository.commonDir, async () => {
      await this.validate(route, workspacePath);
      const status = await git(workspacePath, ["status", "--porcelain", "--untracked-files=all"], this.gitTimeoutMs);
      if (status) throw new Error("현재 branch workspace가 dirty라 fork할 수 없어. 먼저 commit 또는 정리해줘.");
      return git(workspacePath, ["rev-parse", "--verify", "HEAD^{commit}"], this.gitTimeoutMs);
    });
  }

  async prepare(
    route: RouteConfig,
    job: JobRecord,
    onPrepared?: (workspacePath: string) => void | Promise<void>,
    options: WorkspacePrepareOptions = {},
  ): Promise<RouteConfig> {
    if (!route.conversationWorktrees) return route;

    const repository = await this.repositoryIdentity(route);
    const identity = options.identity ?? job.threadId ?? job.conversationKey;
    const defaultWorkspacePath = conversationWorkspacePath(
      this.workspaceRoot,
      repository.commonDir,
      route.id,
      identity,
    );
    const repositoryBucket = safeSegment(repository.commonDir);
    const routeWorkspaceRoot = join(this.workspaceRoot, repositoryBucket, safeSegment(route.id));
    const workspacePath = resolve(options.workspacePath ?? defaultWorkspacePath);
    const relativePath = relative(routeWorkspaceRoot, workspacePath);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
      throw new Error(`workspace path is outside the managed route root: ${workspacePath}`);
    }

    await this.repositoryQueue.run(repository.commonDir, async () => {
      if (existsSync(workspacePath)) {
        await this.validate(route, workspacePath);
        const used = new Date();
        utimesSync(workspacePath, used, used);
        await onPrepared?.(workspacePath);
        return;
      }

      this.assertCapacity(repositoryBucket, workspacePath);
      mkdirSync(resolve(workspacePath, ".."), { recursive: true, mode: 0o700 });
      const baseRef = options.baseRef ?? route.worktreeRef ?? "HEAD";
      const restoreRef = workspaceRestoreRef(workspacePath);
      let commit: string;
      try {
        commit = await git(
          route.cwd,
          ["rev-parse", "--verify", "--end-of-options", `${restoreRef}^{commit}`],
          this.gitTimeoutMs,
        );
      } catch {
        commit = await git(
          route.cwd,
          ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
          this.gitTimeoutMs,
        );
      }
      await git(
        route.cwd,
        [
          "worktree",
          "add",
          "--detach",
          "--lock",
          "--reason",
          `claude-native conversation ${job.conversationKey}`,
          "--",
          workspacePath,
          commit,
        ],
        this.gitTimeoutMs,
      );
      await this.validate(route, workspacePath);
      await onPrepared?.(workspacePath);
    });

    const workspaceInstruction =
      `현재 CWD는 Discord 대화 ${job.conversationKey} 전용 Git worktree다. ` +
      "다른 대화의 worktree나 기준 checkout은 수정하지 마.";
    return {
      ...route,
      cwd: workspacePath,
      instructions: route.instructions
        ? `${route.instructions}\n${workspaceInstruction}`
        : workspaceInstruction,
    };
  }

  private async removeIfSafe(
    candidate: ManagedCandidate,
    beforeRemove?: (path: string, revision: string) => void | Promise<void>,
    afterRemove?: (path: string) => void | Promise<void>,
  ): Promise<string | null> {
    this.assertManagedPath(candidate.path);
    if (statSync(candidate.path).mtimeMs > candidate.lastUsedMs) {
      throw new Error("workspace was touched after cleanup scan");
    }
    const topLevel = realpathSync(await git(candidate.path, ["rev-parse", "--show-toplevel"], this.gitTimeoutMs));
    if (topLevel !== resolve(candidate.path)) throw new Error("not an exact worktree top-level");
    const status = await git(candidate.path, ["status", "--porcelain", "--untracked-files=all"], this.gitTimeoutMs);
    if (status) throw new Error("worktree is dirty");
    const refs = await git(
      candidate.path,
      ["for-each-ref", "--format=%(refname)", "--contains", "HEAD"],
      this.gitTimeoutMs,
    );
    if (!refs) throw new Error("HEAD is not reachable from a Git ref");

    const entries = await this.registeredWorktrees(candidate.path);
    const target = entries.find((entry) => resolve(entry.path) === resolve(candidate.path));
    if (!target) throw new Error("worktree is not registered");
    const admin = entries.find((entry) => resolve(entry.path) !== resolve(candidate.path) && existsSync(entry.path));
    if (!admin) throw new Error("no surviving Git worktree can administer removal");
    const revision = await git(candidate.path, ["rev-parse", "--verify", "HEAD^{commit}"], this.gitTimeoutMs);
    await git(
      candidate.path,
      ["update-ref", workspaceRestoreRef(candidate.path), revision],
      this.gitTimeoutMs,
    );
    await beforeRemove?.(candidate.path, revision);
    if (target.locked) {
      await git(admin.path, ["worktree", "unlock", "--", candidate.path], this.gitTimeoutMs);
    }
    await git(admin.path, ["worktree", "remove", "--", candidate.path], this.gitTimeoutMs);
    await afterRemove?.(candidate.path);
    return candidate.path;
  }

  async recoverPendingCleanup(path: string): Promise<void> {
    const absolute = resolve(path);
    if (!existsSync(absolute)) return;
    this.assertManagedPath(absolute);
    const commonDirRaw = await git(
      absolute,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      this.gitTimeoutMs,
    );
    const commonDir = absoluteGitPath(absolute, commonDirRaw);
    const repositoryBucket = relative(this.workspaceRoot, absolute).split(sep)[0];
    if (!repositoryBucket) throw new Error(`cannot determine managed repository bucket: ${absolute}`);
    const candidate: ManagedCandidate = {
      path: absolute,
      repositoryBucket,
      lastUsedMs: statSync(absolute).mtimeMs,
    };
    await this.repositoryQueue.run(commonDir, () => this.removeIfSafe(candidate));
  }

  async cleanup(options: WorkspaceCleanupOptions = {}): Promise<WorkspaceCleanupResult> {
    const protectedPaths = new Set(
      [...(options.protectedPaths ?? [])].map((path) => resolve(path)),
    );
    const ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1_000;
    const maxTotal = options.maxTotal ?? this.defaultMaxTotal;
    const maxPerRepository = options.maxPerRepository ?? this.defaultMaxPerRepository;
    const nowMs = options.nowMs ?? Date.now();
    const removed: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const candidates = this.listManagedCandidates().sort((a, b) => a.lastUsedMs - b.lastUsedMs);
    const perRepository = new Map<string, number>();
    for (const candidate of candidates) {
      perRepository.set(candidate.repositoryBucket, (perRepository.get(candidate.repositoryBucket) ?? 0) + 1);
    }
    let total = candidates.length;

    for (const candidate of candidates) {
      const repositoryCount = perRepository.get(candidate.repositoryBucket) ?? 0;
      const expired = nowMs - candidate.lastUsedMs >= ttlMs;
      const overQuota = total >= maxTotal || repositoryCount >= maxPerRepository;
      if (!expired && !overQuota) continue;
      if (protectedPaths.has(resolve(candidate.path))) {
        skipped.push({ path: candidate.path, reason: "active job protects workspace" });
        continue;
      }
      try {
        const commonDirRaw = await git(
          candidate.path,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          this.gitTimeoutMs,
        );
        const commonDir = absoluteGitPath(candidate.path, commonDirRaw);
        const removedPath = await this.repositoryQueue.run(commonDir, () =>
          this.removeIfSafe(candidate, options.beforeRemove, options.afterRemove),
        );
        if (!removedPath) continue;
        removed.push(removedPath);
        total -= 1;
        perRepository.set(candidate.repositoryBucket, repositoryCount - 1);
      } catch (error) {
        skipped.push({ path: candidate.path, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { removed, skipped };
  }
}
