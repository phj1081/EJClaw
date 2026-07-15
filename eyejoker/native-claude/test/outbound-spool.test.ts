import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spoolOutboundArtifacts } from "../src/outbound-spool";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("outbound artifact spool", () => {
  test("copies an immutable retry snapshot instead of retaining the source path", () => {
    const root = join(tmpdir(), `native-spool-${crypto.randomUUID()}`);
    roots.push(root);
    const sourceDir = join(root, "source");
    const spoolDir = join(root, "spool");
    mkdirSync(sourceDir, { recursive: true });
    const source = join(sourceDir, "result.txt");
    writeFileSync(source, "original");

    const [spooled] = spoolOutboundArtifacts("job-1", [{ path: source, name: "result.txt" }], spoolDir);
    writeFileSync(source, "mutated");

    expect(spooled?.path).not.toBe(source);
    expect(readFileSync(spooled!.path, "utf8")).toBe("original");
  });

  test("fails closed on symlinks and credential-like names", () => {
    const root = join(tmpdir(), `native-spool-${crypto.randomUUID()}`);
    roots.push(root);
    const source = join(root, "normal.txt");
    const link = join(root, "linked.txt");
    mkdirSync(root, { recursive: true });
    writeFileSync(source, "data");
    symlinkSync(source, link);

    expect(() => spoolOutboundArtifacts("job-link", [{ path: link, name: "linked.txt" }], join(root, "spool"))).toThrow();
    expect(() =>
      spoolOutboundArtifacts("job-secret", [{ path: source, name: "api-token.txt" }], join(root, "spool")),
    ).toThrow("credential성 파일명 거부");
  });
});
