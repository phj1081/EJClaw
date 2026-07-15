import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertClaudeExecutableCompatibility, readInstalledSdkCohort } from "../src/sdk-compat";

describe("Claude Agent SDK compatibility pin", () => {
  test("reads the authoritative cohort from the installed SDK artifact", () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8"),
    ) as { version?: string; claudeCodeVersion?: string };
    const installed = readInstalledSdkCohort();
    expect(installed).toEqual({
      sdkVersion: String(packageJson.version ?? ""),
      claudeCodeVersion: String(packageJson.claudeCodeVersion ?? ""),
    });
    expect(installed.sdkVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(installed.claudeCodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("fails startup when the configured Claude executable is from another cohort", () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-compat-"));
    try {
      const expected = readInstalledSdkCohort();
      const compatible = join(root, "compatible");
      const incompatible = join(root, "incompatible");
      writeFileSync(compatible, `#!/bin/sh\necho '${expected.claudeCodeVersion} (Claude Code)'\n`);
      writeFileSync(incompatible, "#!/bin/sh\necho '9.9.9 (Claude Code)'\n");
      chmodSync(compatible, 0o755);
      chmodSync(incompatible, 0o755);
      expect(() => assertClaudeExecutableCompatibility(compatible)).not.toThrow();
      expect(() => assertClaudeExecutableCompatibility(incompatible)).toThrow("버전 불일치");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("derives the CLI requirement from the installed SDK artifact, not environment overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-artifact-"));
    const previousSdk = process.env.CLAUDE_NATIVE_EXPECTED_SDK_VERSION;
    const previousCli = process.env.CLAUDE_NATIVE_EXPECTED_CLAUDE_VERSION;
    try {
      const sdkPackage = join(root, "package.json");
      const executable = join(root, "claude");
      writeFileSync(sdkPackage, JSON.stringify({ version: "0.3.999", claudeCodeVersion: "2.1.999" }));
      writeFileSync(executable, "#!/bin/sh\necho '2.1.999 (Claude Code)'\n");
      chmodSync(executable, 0o755);
      process.env.CLAUDE_NATIVE_EXPECTED_SDK_VERSION = "9.9.9";
      process.env.CLAUDE_NATIVE_EXPECTED_CLAUDE_VERSION = "9.9.9";

      expect(() => assertClaudeExecutableCompatibility(executable, sdkPackage)).not.toThrow();
    } finally {
      if (previousSdk === undefined) delete process.env.CLAUDE_NATIVE_EXPECTED_SDK_VERSION;
      else process.env.CLAUDE_NATIVE_EXPECTED_SDK_VERSION = previousSdk;
      if (previousCli === undefined) delete process.env.CLAUDE_NATIVE_EXPECTED_CLAUDE_VERSION;
      else process.env.CLAUDE_NATIVE_EXPECTED_CLAUDE_VERSION = previousCli;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
