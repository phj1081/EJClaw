import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractOutboundArtifacts } from "../src/outbound-artifacts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Discord outbound artifacts", () => {
  test("extracts standalone MEDIA paths and keeps validation failures visible", () => {
    const root = join(tmpdir(), `native-outbound-${crypto.randomUUID()}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const image = join(root, "result.png");
    writeFileSync(image, "png");
    const missing = join(root, "missing.log");

    const parsed = extractOutboundArtifacts(`결과 본문\nMEDIA:${image}\nMEDIA:${missing}\n끝`);

    expect(parsed.body).toContain("결과 본문");
    expect(parsed.body).toContain("끝");
    expect(parsed.body).not.toContain(`MEDIA:${image}`);
    expect(parsed.files).toEqual([{ path: image, name: "result.png" }]);
    expect(parsed.errors).toEqual([`${missing}: 파일 없음`]);
    expect(parsed.body).toContain("첨부 실패");
  });
});
