import { describe, expect, test } from "bun:test";
import {
  authorizePullRequestWatch,
  decidePullRequestWatchPreflight,
  githubRepoFromRemote,
  watchMarkersForSuccessfulExecution,
} from "../src/github-watch-registration";

const reference = {
  repo: "phj1081/EJClaw",
  number: 250,
  url: "https://github.com/phj1081/EJClaw/pull/250",
};

const payload = {
  state: "OPEN",
  url: reference.url,
  author: { login: "phj1081" },
  headRepositoryOwner: { login: "phj1081" },
};

describe("GitHub watcher registration authorization", () => {
  test("normalizes HTTPS and SSH GitHub origin remotes", () => {
    expect(githubRepoFromRemote("https://github.com/phj1081/EJClaw.git")).toBe("phj1081/EJClaw");
    expect(githubRepoFromRemote("git@github.com:phj1081/EJClaw.git")).toBe("phj1081/EJClaw");
    expect(githubRepoFromRemote("https://evil.example/phj1081/EJClaw.git")).toBeNull();
  });

  test("ignores markers from failed executions", () => {
    const result = "실패\nPR_WATCH: https://github.com/phj1081/EJClaw/pull/250";
    expect(watchMarkersForSuccessfulExecution({ ok: false, result })).toEqual({
      cleanText: result,
      references: [],
    });
    expect(watchMarkersForSuccessfulExecution({ ok: true, result }).references).toEqual([reference]);
  });

  test("runs watcher jobs only while the PR is open at the expected head", () => {
    expect(decidePullRequestWatchPreflight("old-head", { state: "OPEN", headRefOid: "old-head" })).toEqual({ ok: true });
    expect(decidePullRequestWatchPreflight("old-head", { state: "OPEN", headRefOid: "new-head" })).toEqual({
      ok: false,
      reason: "head-changed:old-head->new-head",
    });
    expect(decidePullRequestWatchPreflight("old-head", { state: "MERGED", headRefOid: "old-head" })).toEqual({
      ok: false,
      reason: "pr-not-open:MERGED",
    });
  });

  test("accepts only an open PR in the route origin authored by the authenticated actor", () => {
    expect(authorizePullRequestWatch(reference, "phj1081/EJClaw", "phj1081", payload)).toEqual({ ok: true });
    expect(authorizePullRequestWatch(
      { ...reference, repo: "attacker/repo", url: "https://github.com/attacker/repo/pull/250" },
      "phj1081/EJClaw",
      "phj1081",
      { ...payload, url: "https://github.com/attacker/repo/pull/250" },
    )).toEqual({ ok: false, reason: "repo-not-authorized" });
    expect(authorizePullRequestWatch(reference, "phj1081/EJClaw", "phj1081", {
      ...payload,
      author: { login: "attacker" },
    })).toEqual({ ok: false, reason: "pr-author-not-authorized" });
    expect(authorizePullRequestWatch(reference, "phj1081/EJClaw", "phj1081", {
      ...payload,
      state: "CLOSED",
    })).toEqual({ ok: false, reason: "pr-not-open" });
  });
});
