import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertClaudeExecutableCompatibility } from "../src/sdk-compat";

describe("Claude Agent SDK compatibility pin", () => {
  const expectedSdkVersion = process.env.CLAUDE_NATIVE_EXPECTED_SDK_VERSION ?? "0.3.201";
  const expectedClaudeVersion = process.env.CLAUDE_NATIVE_EXPECTED_CLAUDE_VERSION ?? "2.1.201";

  test("pins the SDK cohort that matches Claude Code 2.1.201", () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8"),
    ) as { version?: string; claudeCodeVersion?: string };
    expect(packageJson.version).toBe(expectedSdkVersion);
    expect(packageJson.claudeCodeVersion).toBe(expectedClaudeVersion);
  });

  test("fails startup when the configured Claude executable is from another cohort", () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-compat-"));
    try {
      const compatible = join(root, "compatible");
      const incompatible = join(root, "incompatible");
      writeFileSync(compatible, `#!/bin/sh\necho '${expectedClaudeVersion} (Claude Code)'\n`);
      writeFileSync(incompatible, "#!/bin/sh\necho '9.9.9 (Claude Code)'\n");
      chmodSync(compatible, 0o755);
      chmodSync(incompatible, 0o755);
      expect(() => assertClaudeExecutableCompatibility(compatible)).not.toThrow();
      expect(() => assertClaudeExecutableCompatibility(incompatible)).toThrow("버전 불일치");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
