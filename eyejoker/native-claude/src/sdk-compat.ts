import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface InstalledSdkCohort {
  sdkVersion: string;
  claudeCodeVersion: string;
}

const defaultSdkPackagePath = join(
  import.meta.dir,
  "..",
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "package.json",
);

export function readInstalledSdkCohort(packagePath = defaultSdkPackagePath): InstalledSdkCohort {
  const payload = JSON.parse(readFileSync(packagePath, "utf8")) as {
    version?: unknown;
    claudeCodeVersion?: unknown;
  };
  const sdkVersion = String(payload.version ?? "").trim();
  const claudeCodeVersion = String(payload.claudeCodeVersion ?? "").trim();
  if (!sdkVersion || !claudeCodeVersion) {
    throw new Error(`설치된 Claude Agent SDK metadata 불완전: ${packagePath}`);
  }
  return { sdkVersion, claudeCodeVersion };
}

export function assertClaudeExecutableCompatibility(
  executable: string,
  sdkPackagePath = defaultSdkPackagePath,
): void {
  const expected = readInstalledSdkCohort(sdkPackagePath);
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.error) throw new Error(`Claude executable 확인 실패: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Claude executable --version 실패 (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  const versionOutput = `${result.stdout}\n${result.stderr}`;
  if (!new RegExp(`(^|\\s)${expected.claudeCodeVersion.replace(/\./g, "\\.")}($|\\s)`).test(versionOutput)) {
    throw new Error(
      `Claude Code/Agent SDK 버전 불일치: expected CLI ${expected.claudeCodeVersion} for installed SDK ${expected.sdkVersion}, got ${versionOutput.trim()}`,
    );
  }
}
