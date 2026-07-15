#!/usr/bin/env bun
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  candidateCohortKey,
  cohortNeedsVerification,
  cohortNoticeAction,
  normalizeCohortState,
  renderCohortNotice,
  validateCandidateCohort,
  type CohortResult,
  type CohortState,
  type CohortVersions,
} from "./cohort-policy";
import {
  buildBubblewrapInvocation,
  buildBubblewrapProcessInvocation,
  buildCohortSandboxEnvironment,
  buildUnixBrokeredBubblewrapInvocation,
} from "./cohort-sandbox";
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
const bunExecutable = resolve(process.env.CLAUDE_NATIVE_BUN_BIN ?? process.execPath);
const cohortModel = process.env.CLAUDE_NATIVE_COHORT_MODEL ?? "claude-fable-5";
const force = process.argv.includes("--force");
mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
const statePath = join(stateRoot, "last-result.json");

function hostEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    NO_COLOR: "1",
  };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NPM_CONFIG_REGISTRY", "npm_config_cache"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  Object.assign(environment, extra);
  return environment;
}

function versionFromOutput(output: string): string {
  const match = /\b\d+\.\d+\.\d+\b/.exec(output);
  if (!match) throw new Error(`version unavailable: ${output.trim().slice(0, 160)}`);
  return match[0];
}

function commandOutput(command: string, args: string[], cwd = sourceRoot, timeout = 60_000): string {
  const result = spawnSync(command, args, {
    cwd,
    env: hostEnvironment(),
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim().slice(0, 800)}`,
    );
  }
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
  const cliLatest = String(
    JSON.parse(commandOutput("npm", ["view", "@anthropic-ai/claude-code@latest", "version", "--json"])),
  );
  return validateCandidateCohort(sdk, cliLatest);
}

function currentCohort(): CohortVersions {
  const sdk = readJson<{ version?: unknown; claudeCodeVersion?: unknown }>(
    join(sourceRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"),
  );
  const cliVersion = versionFromOutput(commandOutput(currentClaudeExecutable, ["--version"]));
  return validateCandidateCohort(sdk, cliVersion);
}

function prepareCandidateManifest(target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  cpSync(join(sourceRoot, "package.json"), join(target, "package.json"));
}

function copyProjectForCheck(target: string): void {
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (["node_modules", ".git", "package.json", "bun.lock"].includes(entry.name)) continue;
    cpSync(join(sourceRoot, entry.name), join(target, entry.name), { recursive: true });
  }
}

function pruneForLiveSmoke(target: string): void {
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (["node_modules", "package.json", "bun.lock"].includes(entry.name)) continue;
    rmSync(join(target, entry.name), { recursive: true, force: true });
  }
  mkdirSync(join(target, "src"), { recursive: true, mode: 0o700 });
  cpSync(join(sourceRoot, "src", "cohort-smoke.ts"), join(target, "src", "cohort-smoke.ts"));
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

interface UnixBroker {
  baseUrl: string;
  hostSocketPath: string;
  sandboxSocketPath: string;
  loopbackPort: number;
  stop: () => void;
}

function startUnixBroker(
  workRoot: string,
  name: string,
  loopbackPort: number,
  script: string,
  environment: (hostSocketPath: string, baseUrl: string) => Record<string, string>,
): UnixBroker {
  const hostSocketPath = join(workRoot, `.${name}.sock`);
  const sandboxSocketPath = `/work/.${name}.sock`;
  const baseUrl = `http://127.0.0.1:${loopbackPort}`;
  const readyFile = join(stateRoot, `${name}-${crypto.randomUUID()}.json`);
  rmSync(hostSocketPath, { force: true });
  const proxy: ChildProcess = spawn(
    bunExecutable,
    [join(sourceRoot, "src", script), readyFile],
    {
      cwd: sourceRoot,
      env: hostEnvironment(environment(hostSocketPath, baseUrl)),
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(readyFile)) {
        const { socket } = readJson<{ socket?: unknown }>(readyFile);
        if (socket !== hostSocketPath || !existsSync(hostSocketPath)) {
          throw new Error(`${name} returned an invalid Unix socket`);
        }
        return {
          baseUrl,
          hostSocketPath,
          sandboxSocketPath,
          loopbackPort,
          stop: () => {
            proxy.kill("SIGTERM");
            rmSync(readyFile, { force: true });
            rmSync(hostSocketPath, { force: true });
          },
        };
      }
      if (proxy.exitCode !== null) throw new Error(`${name} exited before ready (${proxy.exitCode})`);
      sleep(50);
    }
    throw new Error(`${name} readiness timeout`);
  } catch (error) {
    proxy.kill("SIGKILL");
    rmSync(readyFile, { force: true });
    rmSync(hostSocketPath, { force: true });
    throw error;
  }
}

function startCredentialProxy(workRoot: string): UnixBroker & { credential: string } {
  const upstreamBase = process.env.ANTHROPIC_BASE_URL;
  const upstreamKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
  if (!upstreamBase || !upstreamKey) throw new Error("credentialed cohort smoke requires ANTHROPIC_BASE_URL and API key");
  const credential = randomBytes(32).toString("base64url");
  const broker = startUnixBroker(
    workRoot,
    "cohort-api",
    18_765,
    "cohort-proxy.ts",
    (hostSocketPath) => ({
      ANTHROPIC_BASE_URL: upstreamBase,
      ANTHROPIC_API_KEY: upstreamKey,
      COHORT_PROXY_CLIENT_TOKEN: credential,
      COHORT_PROXY_MAX_REQUESTS: "32",
      COHORT_PROXY_UNIX_SOCKET: hostSocketPath,
    }),
  );
  return { ...broker, credential };
}

function startRegistryProxy(workRoot: string): UnixBroker {
  return startUnixBroker(
    workRoot,
    "cohort-registry",
    18_764,
    "cohort-registry-proxy.ts",
    (hostSocketPath, baseUrl) => ({
      COHORT_REGISTRY_UNIX_SOCKET: hostSocketPath,
      COHORT_REGISTRY_CLIENT_ORIGIN: baseUrl,
      COHORT_REGISTRY_UPSTREAM: "https://registry.npmjs.org/",
      COHORT_REGISTRY_MAX_REQUESTS: "2048",
    }),
  );
}

interface CandidateRunResult {
  status: "passed" | "failed";
  summary: string;
  lockPath: string | null;
  lockSha256: string | null;
}

function preserveCandidateLock(workRoot: string, candidateKey: string): { path: string; sha256: string } | null {
  const source = join(workRoot, "bun.lock");
  if (!existsSync(source)) return null;
  const target = join(stateRoot, `${candidateKey}.bun.lock`);
  cpSync(source, target);
  chmodSync(target, 0o600);
  const sha256 = createHash("sha256").update(readFileSync(target)).digest("hex");
  return { path: target, sha256 };
}

function runCandidate(
  candidate: CohortVersions,
  workRoot: string,
  logPath: string,
  candidateKey: string,
): CandidateRunResult {
  const logs: string[] = [];
  let lockEvidence: { path: string; sha256: string } | null = null;

  const runBun = (
    args: string[],
    environment: Record<string, string>,
    timeout: number,
    broker?: UnixBroker,
  ): string => {
    const invocation = broker
      ? buildUnixBrokeredBubblewrapInvocation(
          workRoot,
          bunExecutable,
          "/sandbox-bin/bun",
          args,
          environment,
          broker.sandboxSocketPath,
          broker.loopbackPort,
        )
      : buildBubblewrapInvocation(workRoot, bunExecutable, args, environment, false);
    logs.push(`$ sandbox bun ${args.join(" ")} network=${broker ? "unix-broker" : "none"}`);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: sourceRoot,
      env: hostEnvironment(),
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
    });
    logs.push(result.stdout ?? "", result.stderr ?? "", `exit=${result.status ?? "null"}`);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`sandbox bun ${args.join(" ")} failed with exit ${result.status}`);
    return result.stdout.trim();
  };

  const runProcess = (
    command: string,
    args: string[],
    environment: Record<string, string>,
    timeout: number,
    broker?: UnixBroker,
  ): string => {
    const invocation = broker
      ? buildUnixBrokeredBubblewrapInvocation(
          workRoot,
          bunExecutable,
          command,
          args,
          environment,
          broker.sandboxSocketPath,
          broker.loopbackPort,
        )
      : buildBubblewrapProcessInvocation(
          workRoot,
          bunExecutable,
          command,
          args,
          environment,
          false,
        );
    logs.push(`$ sandbox ${basename(command)} ${args.join(" ")} network=${broker ? "unix-broker" : "none"}`);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: sourceRoot,
      env: hostEnvironment(),
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
    });
    logs.push(result.stdout ?? "", result.stderr ?? "", `exit=${result.status ?? "null"}`);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`sandbox ${basename(command)} failed with exit ${result.status}`);
    return result.stdout.trim();
  };

  try {
    const packagePath = join(workRoot, "package.json");
    const packageJson = readJson<Record<string, any>>(packagePath);
    packageJson.dependencies = {
      ...(packageJson.dependencies ?? {}),
      "@anthropic-ai/claude-agent-sdk": candidate.sdkVersion,
    };
    packageJson.devDependencies = {
      ...(packageJson.devDependencies ?? {}),
      "@anthropic-ai/claude-code": candidate.claudeCodeVersion,
    };
    packageJson.trustedDependencies = [
      ...new Set([...(packageJson.trustedDependencies ?? []), "@anthropic-ai/claude-code"]),
    ];
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    rmSync(join(workRoot, "bun.lock"), { force: true });

    const staticEnvironment = {
      ...buildCohortSandboxEnvironment(
        candidate,
        "http://127.0.0.1:9",
        "cohort-install-non-secret",
        cohortModel,
      ),
      BUN_CONFIG_REGISTRY: "http://127.0.0.1:18764/",
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:18764/",
      npm_config_registry: "http://127.0.0.1:18764/",
    };
    const registry = startRegistryProxy(workRoot);
    try {
      runBun(["install"], staticEnvironment, 10 * 60_000, registry);
    } finally {
      registry.stop();
    }
    lockEvidence = preserveCandidateLock(workRoot, candidateKey);
    if (!lockEvidence) throw new Error("candidate install produced no bun.lock evidence");
    copyProjectForCheck(workRoot);

    const installedSdk = readJson<{ version?: unknown; claudeCodeVersion?: unknown }>(
      join(workRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"),
    );
    const candidateExecutable = "/work/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
    const installedCliVersion = versionFromOutput(
      runProcess(candidateExecutable, ["--version"], staticEnvironment, 60_000),
    );
    validateCandidateCohort(installedSdk, installedCliVersion);
    runBun(["run", "check"], staticEnvironment, 20 * 60_000);
    pruneForLiveSmoke(workRoot);

    const proxy = startCredentialProxy(workRoot);
    try {
      const liveEnvironment = buildCohortSandboxEnvironment(
        candidate,
        proxy.baseUrl,
        proxy.credential,
        cohortModel,
      );
      runBun(
        ["run", "src/cohort-smoke.ts", candidateExecutable],
        liveEnvironment,
        10 * 60_000,
        proxy,
      );
    } finally {
      proxy.stop();
    }

    writeFileSync(logPath, `${logs.join("\n")}\n`, { mode: 0o600 });
    chmodSync(logPath, 0o600);
    return {
      status: "passed",
      summary: `lo-only bwrap와 Unix broker 제한 install/live smoke 통과; lock sha256=${lockEvidence.sha256}`,
      lockPath: lockEvidence.path,
      lockSha256: lockEvidence.sha256,
    };
  } catch (error) {
    if (!lockEvidence) lockEvidence = preserveCandidateLock(workRoot, candidateKey);
    logs.push(`ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    writeFileSync(logPath, `${logs.join("\n")}\n`, { mode: 0o600 });
    chmodSync(logPath, 0o600);
    return {
      status: "failed",
      summary: error instanceof Error ? error.message : String(error),
      lockPath: lockEvidence?.path ?? null,
      lockSha256: lockEvidence?.sha256 ?? null,
    };
  }
}

function noticePrompt(result: CohortResult): string {
  return [
    "정기 Claude Code/Agent SDK cohort verifier의 결정적 결과다. production 코드·패키지·서비스는 절대 변경하지 말고 아래 내용을 한국어로 간결하게 그대로 보고해.",
    "",
    renderCohortNotice(result),
  ].join("\n");
}

function ensureNotice(state: CohortState): ReturnType<typeof cohortNoticeAction> {
  const config = loadConfig(configPath);
  const routeId = process.env.CLAUDE_NATIVE_COHORT_ROUTE ?? config.routes[0]!.id;
  const route = config.routes.find((candidate) => candidate.id === routeId);
  if (!route) throw new Error(`unknown cohort notice route: ${routeId}`);
  const store = new StateStore(stateDb);
  try {
    const existing = store.getByMessageId(state.noticeMessageId);
    const action = cohortNoticeAction(existing?.status ?? null);
    const prompt = noticePrompt(state);
    if (action === "enqueue") {
      store.enqueue({
        routeId: route.id,
        lockKey: route.lockKey ?? route.cwd,
        conversationKey: `cohort-verifier:${route.id}`,
        channelId: route.discordChannelId,
        threadId: null,
        messageId: state.noticeMessageId,
        authorId: config.ownerId,
        prompt,
        attachmentPaths: [],
      });
    } else if (action === "requeue") {
      const replay = store.requeueTerminalByMessageId(
        state.noticeMessageId,
        "durable cohort notice replay",
        prompt,
      );
      if (!replay) throw new Error(`failed to requeue cohort notice: ${state.noticeMessageId}`);
    } else if (existing?.status === "queued") {
      store.updateQueuedPrompt(state.noticeMessageId, prompt);
    }
    return action;
  } finally {
    store.close();
  }
}

function withPreservedLockEvidence(state: CohortState): CohortState {
  if (state.lockPath && state.lockSha256) return state;
  const preservedLock = join(stateRoot, `${state.candidateKey}.bun.lock`);
  if (!existsSync(preservedLock)) return state;
  return {
    ...state,
    lockPath: preservedLock,
    lockSha256: createHash("sha256").update(readFileSync(preservedLock)).digest("hex"),
  };
}

const current = currentCohort();
const candidate = latestCandidate();
const previousValue = existsSync(statePath) ? readJson<unknown>(statePath) : null;
const normalizedPrevious = normalizeCohortState(previousValue);
const previousState = normalizedPrevious ? withPreservedLockEvidence(normalizedPrevious) : null;
if (previousState && JSON.stringify(previousValue) !== JSON.stringify(previousState)) {
  writePrivateJson(statePath, previousState);
}
const previous = previousState as Pick<CohortState, "candidateKey" | "status"> | null;
let reconciledNotice: ReturnType<typeof cohortNoticeAction> | null = null;
if (previousState) reconciledNotice = ensureNotice(previousState);

if (candidateCohortKey(current) === candidateCohortKey(candidate)) {
  console.log(JSON.stringify({ status: "up-to-date", current, reconciledNotice }));
  process.exit(0);
}
if (!cohortNeedsVerification(previous, candidate, force)) {
  console.log(JSON.stringify({ status: "unchanged", candidate, reconciledNotice }));
  process.exit(0);
}

const candidateKey = candidateCohortKey(candidate);
const workRoot = join(tmpdir(), `claude-native-${candidateKey}-${crypto.randomUUID()}`);
const logPath = join(stateRoot, `${candidateKey}.log`);
let runResult: CandidateRunResult;
try {
  prepareCandidateManifest(workRoot);
  runResult = runCandidate(candidate, workRoot, logPath, candidateKey);
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
  lockPath: runResult.lockPath,
  lockSha256: runResult.lockSha256,
};
const state: CohortState = {
  candidateKey,
  noticeMessageId: `cohort-verifier:${candidateKey}:${result.status}`,
  ...result,
};
writePrivateJson(statePath, state);
const noticeAction = ensureNotice(state);
console.log(JSON.stringify({ status: result.status, candidate, logPath, lockPath: result.lockPath, lockSha256: result.lockSha256, noticeAction }));
if (result.status === "failed") process.exitCode = 1;
