import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveRoute } from "../src/config";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = join(tmpdir(), `native-config-${crypto.randomUUID()}`);
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const configPath = join(root, "routes.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      owner_id: "216851709744513024",
      max_concurrent: 2,
      routes: [
        {
          id: "cleanapo",
          discord_channel_id: "100",
          cwd: project,
          model: "claude-fable-5",
          fallback_model: "gpt-5.6-sol",
          effort: "high",
          permission_mode: "bypassPermissions",
          require_mention: false,
        },
      ],
    }),
  );
  roots.push(root);
  return { configPath, project };
}

describe("route config", () => {
  test("loads validated routes and resolves thread messages by parent channel", () => {
    const { configPath, project } = fixture();
    const config = loadConfig(configPath);
    expect(config.routes[0]?.cwd).toBe(project);
    expect(config.routes[0]?.fallbackModel).toBe("gpt-5.6-sol");
    expect(resolveRoute(config, "thread-7", "100")?.id).toBe("cleanapo");
    expect(resolveRoute(config, "100", null)?.id).toBe("cleanapo");
    expect(resolveRoute(config, "999", null)).toBeNull();
  });

  test("rejects duplicate channel mappings and missing project directories", () => {
    const { configPath } = fixture();
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    raw.routes.push({ ...raw.routes[0], id: "duplicate" });
    writeFileSync(configPath, JSON.stringify(raw));
    expect(() => loadConfig(configPath)).toThrow(/duplicate/i);

    raw.routes = [{ ...raw.routes[0], cwd: "/definitely/missing/native-project" }];
    writeFileSync(configPath, JSON.stringify(raw));
    expect(() => loadConfig(configPath)).toThrow(/cwd/i);
  });
});
