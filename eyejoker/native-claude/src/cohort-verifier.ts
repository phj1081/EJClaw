#!/usr/bin/env bun
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  candidateCohortKey,
  cohortNeedsVerification,
  renderCohortNotice,
  validateCandidateCohort,
  type CohortResult,
  type CohortState,
  type CohortVersions,
} from "./cohort-policy";
import { loadConfig } from "./config";
import { StateStore } from "./store";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDb = resolve(
  process.env.CLAUDE_NATIVE_STATE_DB ?? join(home, ".local/state/claude-native/state.sqlite"),
);
const stateRoot = resolve(
  process.env.CLAUDE_NATIVE_COHORT_DIR ?? join(stateDb, "..", "cohort-verifier"),
);
const configPath = resolve(process.env.CLAUDE_NATIVE_CONFIG ?? join(home, ".config/claude-native/routes.json"));
const currentClaudeExecutable = resolve(
  process.env.CLAUDE_NATIVE_CLAUDE_BIN ?? join(home, ".hermes/node/bin/claude"),
);
const force = process.argv.includes("--force");
mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
const statePath = join(stateRoot, "last-result.json");

function versionFromOutput(output: string): string {
  const match = /\b\d+\.\d+\.\d+\b/.exec(output);
  if (!match) throw new Error(`version unavailable: ${output.trim().slice(0, 160)}`);
  return match[0];
}

function commandOutput(command: string, args: string[], cwd = sourceRoot, timeout = 60_000): string {
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: "utf8", timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim().slice(0, 800)}`);
  return result.stdout.trim();
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function latestCandidate(): CohortVersions {
  const sdk = JSON.parse(
    commandOutput("npm", ["view", "@anthropic-ai/claude-agent-sdk@latest", "version", "claudeCodeVersion", "--json"]),
  ) as { version?: unknown; claudeCodeVersion?: unknown };
  const cliLatest = String(JSON.parse(commandOutput("npm", ["view", "@anthropic-ai/claude-code@latest", "version", "--json"])));
  return validateCandidateCohort(sdk, cliLatest);
}

function currentCohort(): CohortVersions {
  const sdk = readJson<{ version?: unknown; claudeCodeVersion?: unknown }>(
    join(sourceRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"),
  );
  const cliVersion = versionFromOutput(commandOutput(currentClaudeExecutable, ["--version"]));
  return validateCandidateCohort(sdk, cliVersion);
}

function copySource(target: string): void {
  cpSync(sourceRoot, target, {
    recursive: true,
    filter: (source) => {
      const rel = relative(sourceRoot, source);
      return rel !== "node_modules" && !rel.startsWith(`node_modules/`) && rel !== ".git" && !rel.startsWith(`.git/`);
    },
  });
}

function runCandidate(candidate: CohortVersions, workRoot: string, logPath: string): { status: "passed" | "failed"; summary: string } {
  const logs: string[] = [];
  const run = (command: string, args: string[], timeout: number) => {
    logs.push(`$ ${command} ${args.join(" ")}`);
    const result = spawnSync(command, args, {
      cwd: workRoot,
      env: {
        ...process.env,
        CLAUDE_NATIVE_EXPECTED_SDK_VERSION: candidate.sdkVersion,
        CLAUDE_NATIVE_EXPECTED_CLAUDE_VERSION: candidate.claudeCodeVersion,
      },
      encoding: "utf8",
      timeout,
    });
    logs.push(result.stdout ?? "", result.stderr ?? "", `exit=${result.status ?? "null"}`);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${basename(command)} failed with exit ${result.status}`);
  };

  try {
    const packagePath = join(workRoot, "package.json");
    const packageJson = readJson<Record<string, any>>(packagePath);
    packageJson.dependencies = { ...(packageJson.dependencies ?? {}), "@anthropic-ai/claude-agent-sdk": candidate.sdkVersion };
    packageJson.devDependencies = { ...(packageJson.devDependencies ?? {}), "@anthropic-ai/claude-code": candidate.claudeCodeVersion };
    packageJson.trustedDependencies = [
      ...new Set([...(packageJson.trustedDependencies ?? []), "@anthropic-ai/claude-code"]),
    ];
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    rmSync(join(workRoot, "bun.lock"), { force: true });
    run("bun", ["install"], 10 * 60_000);

    const installedSdk = readJson<{ version?: unknown; claudeCodeVersion?: unknown }>(
      join(workRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"),
    );
    const candidateExecutable = join(
      workRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    const installedCliVersion = versionFromOutput(commandOutput(candidateExecutable, ["--version"], workRoot));
    validateCandidateCohort(installedSdk, installedCliVersion);
    run("bun", ["run", "check"], 20 * 60_000);
    run("bun", ["run", "src/cohort-smoke.ts", candidateExecutable], 10 * 60_000);
    writeFileSync(logPath, `${logs.join("\n")}\n`, { mode: 0o600 });
    chmodSync(logPath, 0o600);
    return { status: "passed", summary: "격리 install, 전체 tests/typecheck, AskUserQuestion·Bash·session resume live smoke 통과" };
  } catch (error) {
    logs.push(`ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    writeFileSync(logPath, `${logs.join("\n")}\n`, { mode: 0o600 });
    chmodSync(logPath, 0o600);
    return { status: "failed", summary: error instanceof Error ? error.message : String(error) };
  }
}

function enqueueNotice(result: CohortResult): void {
  const config = loadConfig(configPath);
  const routeId = process.env.CLAUDE_NATIVE_COHORT_ROUTE ?? config.routes[0]!.id;
  const route = config.routes.find((candidate) => candidate.id === routeId);
  if (!route) throw new Error(`unknown cohort notice route: ${routeId}`);
  const store = new StateStore(stateDb);
  try {
    const key = candidateCohortKey(result.candidate);
    store.enqueue({
      routeId: route.id,
      lockKey: route.lockKey ?? route.cwd,
      conversationKey: `cohort-verifier:${route.id}`,
      channelId: route.discordChannelId,
      threadId: null,
      messageId: `cohort-verifier:${key}:${result.status}`,
      authorId: config.ownerId,
      prompt: [
        "정기 Claude Code/Agent SDK cohort verifier의 결정적 결과다. production 코드·패키지·서비스는 절대 변경하지 말고 아래 내용을 한국어로 간결하게 그대로 보고해.",
        "",
        renderCohortNotice(result),
      ].join("\n"),
      attachmentPaths: [],
    });
  } finally {
    store.close();
  }
}

const current = currentCohort();
const candidate = latestCandidate();
if (candidateCohortKey(current) === candidateCohortKey(candidate)) {
  console.log(JSON.stringify({ status: "up-to-date", current }));
  process.exit(0);
}
const previous = existsSync(statePath) ? readJson<CohortState>(statePath) : null;
if (!cohortNeedsVerification(previous, candidate, force)) {
  console.log(JSON.stringify({ status: "unchanged", candidate }));
  process.exit(0);
}

const candidateKey = candidateCohortKey(candidate);
const workRoot = join(tmpdir(), `claude-native-${candidateKey}-${crypto.randomUUID()}`);
const logPath = join(stateRoot, `${candidateKey}.log`);
let runResult: { status: "passed" | "failed"; summary: string };
try {
  copySource(workRoot);
  runResult = runCandidate(candidate, workRoot, logPath);
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}
const result: CohortResult = {
  current,
  candidate,
  status: runResult.status,
  summary: runResult.summary,
  checkedAt: new Date().toISOString(),
  logPath,
};
writePrivateJson(statePath, { candidateKey, ...result });
enqueueNotice(result);
console.log(JSON.stringify({ status: result.status, candidate, logPath }));
