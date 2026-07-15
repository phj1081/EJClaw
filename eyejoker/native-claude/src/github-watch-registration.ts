import { spawnSync } from "node:child_process";
import type { PullRequestReference, ParsedPullRequestWatchMarkers } from "./github-watch-policy";
import { parsePullRequestWatchMarkers } from "./github-watch-policy";
import type { JobRecord, PreflightDecision } from "./types";

interface PullRequestRegistrationPayload {
  state?: unknown;
  url?: unknown;
  author?: { login?: unknown } | null;
  headRepositoryOwner?: { login?: unknown } | null;
}

interface PullRequestPreflightPayload {
  state?: unknown;
  headRefOid?: unknown;
}

export function decidePullRequestWatchPreflight(
  expectedHeadSha: string,
  payload: PullRequestPreflightPayload,
): PreflightDecision {
  const state = String(payload.state ?? "UNKNOWN").toUpperCase();
  const head = String(payload.headRefOid ?? "");
  if (state !== "OPEN") return { ok: false, reason: `pr-not-open:${state}` };
  if (head !== expectedHeadSha) return { ok: false, reason: `head-changed:${expectedHeadSha}->${head || "unknown"}` };
  return { ok: true };
}

export type PullRequestAuthorization =
  | { ok: true }
  | { ok: false; reason: string };

export function watchMarkersForSuccessfulExecution(
  execution: Pick<{ ok: boolean; result: string }, "ok" | "result">,
): ParsedPullRequestWatchMarkers {
  return execution.ok
    ? parsePullRequestWatchMarkers(execution.result)
    : { cleanText: execution.result, references: [] };
}

export function githubRepoFromRemote(remote: string): string | null {
  const value = remote.trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  return match?.[1] ?? null;
}

export function authorizePullRequestWatch(
  reference: PullRequestReference,
  routeRepo: string,
  authenticatedLogin: string,
  payload: PullRequestRegistrationPayload,
): PullRequestAuthorization {
  if (reference.repo.toLowerCase() !== routeRepo.toLowerCase()) {
    return { ok: false, reason: "repo-not-authorized" };
  }
  if (String(payload.state ?? "").toUpperCase() !== "OPEN") {
    return { ok: false, reason: "pr-not-open" };
  }
  if (String(payload.url ?? "").toLowerCase() !== reference.url.toLowerCase()) {
    return { ok: false, reason: "pr-url-mismatch" };
  }
  if (String(payload.author?.login ?? "").toLowerCase() !== authenticatedLogin.toLowerCase()) {
    return { ok: false, reason: "pr-author-not-authorized" };
  }
  return { ok: true };
}

function command(command: string, args: string[], cwd: string, timeout: number): string {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} authorization lookup failed (${result.status}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
  return result.stdout.trim();
}

export function verifyPullRequestWatchPreflight(
  routeCwd: string,
  job: Pick<JobRecord, "githubWatchRepo" | "githubWatchNumber" | "expectedHeadSha">,
): PreflightDecision {
  if (!job.githubWatchRepo && !job.githubWatchNumber && !job.expectedHeadSha) return { ok: true };
  if (!job.githubWatchRepo || !job.githubWatchNumber || !job.expectedHeadSha) {
    throw new Error("incomplete GitHub watcher preflight metadata");
  }
  const payload = JSON.parse(command(
    "gh",
    [
      "pr",
      "view",
      String(job.githubWatchNumber),
      "--repo",
      job.githubWatchRepo,
      "--json",
      "state,headRefOid",
    ],
    routeCwd,
    15_000,
  )) as PullRequestPreflightPayload;
  return decidePullRequestWatchPreflight(job.expectedHeadSha, payload);
}

export function verifyPullRequestWatchAuthorization(
  routeCwd: string,
  reference: PullRequestReference,
): PullRequestAuthorization {
  const routeRepo = githubRepoFromRemote(command("git", ["remote", "get-url", "origin"], routeCwd, 5_000));
  if (!routeRepo) return { ok: false, reason: "route-origin-not-github" };
  const authenticatedLogin = command("gh", ["api", "user", "--jq", ".login"], routeCwd, 15_000);
  const payload = JSON.parse(command(
    "gh",
    [
      "pr",
      "view",
      String(reference.number),
      "--repo",
      reference.repo,
      "--json",
      "state,url,author,headRepositoryOwner",
    ],
    routeCwd,
    15_000,
  )) as PullRequestRegistrationPayload;
  return authorizePullRequestWatch(reference, routeRepo, authenticatedLogin, payload);
}
