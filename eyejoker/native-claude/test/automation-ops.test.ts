import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("native automation systemd contracts", () => {
  test("polls durable PR watches without exposing a public webhook", () => {
    const service = readFileSync(join(import.meta.dir, "..", "ops", "claude-native-github-watch.service"), "utf8");
    const timer = readFileSync(join(import.meta.dir, "..", "ops", "claude-native-github-watch.timer"), "utf8");
    expect(service).toContain("src/github-watch.ts");
    expect(service).toContain("CLAUDE_NATIVE_STATE_DB");
    expect(service).not.toContain("EnvironmentFile=");
    expect(service).toContain("UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN DISCORD_BOT_TOKEN");
    expect(service).toContain("UMask=0077");
    expect(service).toContain("PrivateDevices=true");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("ProtectHome=read-only");
    expect(service).toContain("ReadWritePaths=/home/ejclaw/.local/state/claude-native");
    expect(timer).toContain("OnUnitActiveSec=2min");
    expect(timer).toContain("Persistent=true");
  });

  test("runs cohort verification weekly and keeps it isolated from the bridge", () => {
    const service = readFileSync(join(import.meta.dir, "..", "ops", "claude-native-cohort-verifier.service"), "utf8");
    const timer = readFileSync(join(import.meta.dir, "..", "ops", "claude-native-cohort-verifier.timer"), "utf8");
    expect(service).toContain("src/cohort-verifier.ts");
    expect(service).toContain("PrivateTmp=true");
    expect(service).toContain("/home/ejclaw/.bun/bin");
    expect(service).toContain("/home/ejclaw/.hermes/node/bin");
    const verifier = readFileSync(join(import.meta.dir, "..", "src", "cohort-verifier.ts"), "utf8");
    const smoke = readFileSync(join(import.meta.dir, "..", "src", "cohort-smoke.ts"), "utf8");
    const envExample = readFileSync(join(import.meta.dir, "..", "ops", "env.example"), "utf8");
    expect(verifier).toContain('"@anthropic-ai/claude-code"');
    expect(verifier).toContain("trustedDependencies");
    expect(verifier).toContain("buildBubblewrapInvocation");
    expect(verifier).not.toContain("...process.env");
    expect(smoke).toContain('tools: ["AskUserQuestion"]');
    expect(smoke).not.toContain("tools: { type: \"preset\", preset: \"claude_code\" }");
    expect(smoke).not.toContain("...process.env");
    expect(service).toContain("ProtectHome=read-only");
    expect(service).toContain("ReadWritePaths=/home/ejclaw/.local/state/claude-native");
    expect(service).toContain("NPM_CONFIG_CACHE=/home/ejclaw/.local/state/claude-native/npm-cache");
    expect(service).toContain("UnsetEnvironment=DISCORD_BOT_TOKEN");
    expect(envExample).toContain("DISCORD_STATE_DIR=/home/ejclaw/.claude/channels/discord-owner");
    expect(envExample).not.toContain("discord-pilot");
    expect(timer).toContain("OnCalendar=");
    expect(timer).toContain("Persistent=true");
    expect(service).not.toContain("systemctl restart claude-native-bridge");
  });
});
