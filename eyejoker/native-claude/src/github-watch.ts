#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { loadConfig } from "./config";
import { conversationLockKey } from "./conversation-workspace";
import {
  buildPullRequestWakePrompt,
  decidePullRequestWake,
  pullRequestActionKey,
  pullRequestSnapshotSignal,
  snapshotFromGitHub,
  type GitHubPullRequestPayload,
  type GitHubPullRequestSnapshot,
} from "./github-watch-policy";
import { StateStore } from "./store";

const activeJobStatuses = new Set(["queued", "running", "delivering"]);
const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const configPath = resolve(process.env.CLAUDE_NATIVE_CONFIG ?? join(home, ".config/claude-native/routes.json"));
const statePath = resolve(
  process.env.CLAUDE_NATIVE_STATE_DB ?? join(home, ".local/state/claude-native/state.sqlite"),
);
const config = loadConfig(configPath);
const store = new StateStore(statePath);

function previousSnapshot(value: string | null): GitHubPullRequestSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as GitHubPullRequestSnapshot;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function fetchPullRequest(repo: string, number: number): GitHubPullRequestPayload {
  const configuredTimeout = Number(process.env.CLAUDE_NATIVE_GH_TIMEOUT_MS ?? "15000");
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout >= 50 ? configuredTimeout : 15_000;
  const result = spawnSync(
    "gh",
    [
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "author,state,headRefOid,reviewDecision,mergeStateStatus,updatedAt,comments,reviews,statusCheckRollup",
    ],
    { env: process.env, encoding: "utf8", timeout, killSignal: "SIGKILL" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 800);
    throw new Error(`gh pr view failed (${result.status}): ${detail}`);
  }
  return JSON.parse(result.stdout) as GitHubPullRequestPayload;
}

let observed = 0;
let woke = 0;
let completed = 0;
let errors = 0;
try {
  for (const watch of store.listActivePullRequestWatches()) {
    const route = config.routes.find((candidate) => candidate.id === watch.routeId);
    if (!route) {
      store.completePullRequestWatch(watch.id, "route-removed");
      completed += 1;
      continue;
    }
    if (Date.parse(watch.expiresAt) <= Date.now()) {
      store.completePullRequestWatch(watch.id, "expired");
      completed += 1;
      continue;
    }
    try {
      const reference = { repo: watch.repo, number: watch.number, url: watch.url };
      const current = snapshotFromGitHub(fetchPullRequest(watch.repo, watch.number));
      const signal = pullRequestSnapshotSignal(current);
      const decision = decidePullRequestWake(previousSnapshot(watch.lastObservedSignal), current);
      if (decision.kind === "complete") {
        store.completePullRequestWatch(watch.id, decision.reason);
        completed += 1;
        continue;
      }
      if (decision.kind === "observe") {
        store.recordPullRequestObservation(watch.id, signal);
        observed += 1;
        continue;
      }
      const actionKey = pullRequestActionKey(current, decision.reason);
      const activeJob = watch.activeJobId ? store.getJob(watch.activeJobId) : null;
      if (activeJob && activeJobStatuses.has(activeJob.status)) {
        observed += 1;
        continue;
      }
      if (watch.lastWakeSignal === actionKey) {
        store.recordPullRequestObservation(watch.id, signal);
        observed += 1;
        continue;
      }
      if (watch.wakeCount >= 12) {
        store.completePullRequestWatch(watch.id, "wake-limit");
        completed += 1;
        continue;
      }
      const signalId = createHash("sha256").update(actionKey).digest("hex").slice(0, 20);
      const job = store.enqueue({
        routeId: watch.routeId,
        lockKey: conversationLockKey(route, watch.conversationKey),
        conversationKey: watch.conversationKey,
        channelId: watch.channelId,
        threadId: watch.threadId,
        messageId: `github-watch:${watch.id}:${signalId}`,
        authorId: watch.authorId,
        prompt: buildPullRequestWakePrompt(reference, current, decision.reason),
        attachmentPaths: [],
        sessionId: watch.sessionId,
        pinnedSession: true,
        githubWatchRepo: watch.repo,
        githubWatchNumber: watch.number,
        expectedHeadSha: current.headSha,
      });
      store.recordPullRequestObservation(watch.id, signal, job.id, actionKey);
      woke += 1;
    } catch (error) {
      errors += 1;
      console.warn(`github watch failed id=${watch.id} repo=${watch.repo} pr=${watch.number}`, String(error));
    }
  }
  console.log(JSON.stringify({ observed, woke, completed, errors }));
  if (errors > 0) process.exitCode = 1;
} finally {
  store.close();
}
