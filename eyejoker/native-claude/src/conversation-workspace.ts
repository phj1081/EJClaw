import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

function absoluteGitPath(cwd: string, value: string): string {
  return realpathSync(resolve(cwd, value));
}

export class ConversationWorkspaceManager {
  private readonly repositoryQueue = new KeyedSerialQueue();
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string, private readonly gitTimeoutMs = 120_000) {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  async prepare(route: RouteConfig, job: JobRecord): Promise<RouteConfig> {
    if (!route.conversationWorktrees) return route;

    const commonDirRaw = await git(route.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], this.gitTimeoutMs);
    const commonDir = absoluteGitPath(route.cwd, commonDirRaw);
    const repoRoot = dirname(commonDir);
    const identity = job.threadId ?? job.conversationKey;
    const workspacePath = conversationWorkspacePath(this.workspaceRoot, commonDir, route.id, identity);

    await this.repositoryQueue.run(commonDir, async () => {
      if (existsSync(workspacePath)) {
        const existingCommonRaw = await git(
          workspacePath,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          this.gitTimeoutMs,
        );
        const existingCommon = absoluteGitPath(workspacePath, existingCommonRaw);
        if (existingCommon !== commonDir) {
          throw new Error(`workspace path belongs to another repository: ${workspacePath}`);
        }
        return;
      }

      mkdirSync(dirname(workspacePath), { recursive: true, mode: 0o700 });
      const baseRef = route.worktreeRef ?? "HEAD";
      await git(
        repoRoot,
        [
          "worktree",
          "add",
          "--detach",
          "--lock",
          "--reason",
          `claude-native conversation ${job.conversationKey}`,
          "--",
          workspacePath,
          baseRef,
        ],
        this.gitTimeoutMs,
      );
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
}
