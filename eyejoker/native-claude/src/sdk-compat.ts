import { spawnSync } from "node:child_process";

export const EXPECTED_CLAUDE_CODE_VERSION =
  process.env.CLAUDE_NATIVE_EXPECTED_CLAUDE_VERSION ?? "2.1.201";
export const EXPECTED_AGENT_SDK_VERSION =
  process.env.CLAUDE_NATIVE_EXPECTED_SDK_VERSION ?? "0.3.201";

export function assertClaudeExecutableCompatibility(executable: string): void {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (result.error) throw new Error(`Claude executable 확인 실패: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Claude executable --version 실패 (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  const versionOutput = `${result.stdout}\n${result.stderr}`;
  if (!new RegExp(`(^|\\s)${EXPECTED_CLAUDE_CODE_VERSION.replace(/\./g, "\\.")}($|\\s)`).test(versionOutput)) {
    throw new Error(
      `Claude Code/Agent SDK 버전 불일치: expected CLI ${EXPECTED_CLAUDE_CODE_VERSION} for SDK ${EXPECTED_AGENT_SDK_VERSION}, got ${versionOutput.trim()}`,
    );
  }
}
