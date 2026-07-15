import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CohortVersions } from "./cohort-policy";

export interface SandboxInvocation {
  command: string;
  args: string[];
}

export function buildCohortSandboxEnvironment(
  candidate: CohortVersions,
  proxyBaseUrl: string,
  proxyCredential: string,
  model: string,
): Record<string, string> {
  return {
    HOME: "/home/cohort",
    USER: "cohort",
    LOGNAME: "cohort",
    SHELL: "/bin/sh",
    TMPDIR: "/tmp",
    XDG_CONFIG_HOME: "/home/cohort/.config",
    XDG_CACHE_HOME: "/home/cohort/.cache",
    PATH: "/sandbox-bin:/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    CLAUDE_NATIVE_COHORT_SANDBOX: "1",
    NO_COLOR: "1",
    NO_PROXY: "127.0.0.1,localhost",
    ANTHROPIC_BASE_URL: proxyBaseUrl,
    ANTHROPIC_API_KEY: proxyCredential,
    CLAUDE_CONFIG_DIR: "/home/cohort/.claude",
    CLAUDE_NATIVE_EXPECTED_SDK_VERSION: candidate.sdkVersion,
    CLAUDE_NATIVE_EXPECTED_CLAUDE_VERSION: candidate.claudeCodeVersion,
    CLAUDE_NATIVE_COHORT_MODEL: model,
    CLAUDE_AGENT_SDK_CLIENT_APP: "eyejoker-cohort-verifier/0.2.0",
  };
}

export function buildBubblewrapInvocation(
  workRoot: string,
  bunExecutable: string,
  bunArgs: string[],
  environment: Record<string, string>,
  shareNetwork = true,
): SandboxInvocation {
  return buildBubblewrapProcessInvocation(
    workRoot,
    bunExecutable,
    "/sandbox-bin/bun",
    bunArgs,
    environment,
    shareNetwork,
  );
}

export function buildBubblewrapProcessInvocation(
  workRoot: string,
  bunExecutable: string,
  sandboxCommand: string,
  commandArgs: string[],
  environment: Record<string, string>,
  shareNetwork = true,
): SandboxInvocation {
  const runtimeDnsMounts = existsSync("/run/systemd/resolve")
    ? ["--dir", "/run", "--dir", "/run/systemd", "--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve"]
    : [];
  const args = [
    "--unshare-all",
    ...(shareNetwork ? ["--share-net"] : []),
    "--new-session",
    "--die-with-parent",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/etc", "/etc",
    ...runtimeDnsMounts,
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", "/home",
    "--dir", "/home/cohort",
    "--dir", "/sandbox-bin",
    "--ro-bind", resolve(bunExecutable), "/sandbox-bin/bun",
    "--bind", resolve(workRoot), "/work",
    "--chdir", "/work",
    "--clearenv",
  ];
  for (const [key, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) {
    args.push("--setenv", key, value);
  }
  args.push(sandboxCommand, ...commandArgs);
  return { command: "/usr/bin/bwrap", args };
}
