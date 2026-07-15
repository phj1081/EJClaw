import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeBoundedResponse } from "../src/bounded-download";

const paths: string[] = [];
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

function streamedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }),
  );
}

describe("bounded attachment download", () => {
  test("streams a response to disk without buffering the whole body", async () => {
    const path = join(tmpdir(), `bounded-${crypto.randomUUID()}.txt`);
    paths.push(path);
    expect(await writeBoundedResponse(streamedResponse(["one", "two"]), path, 10)).toBe(6);
    expect(readFileSync(path, "utf8")).toBe("onetwo");
  });

  test("deletes a partial file as soon as the body exceeds the cap", async () => {
    const path = join(tmpdir(), `bounded-${crypto.randomUUID()}.txt`);
    paths.push(path);
    await expect(writeBoundedResponse(streamedResponse(["1234", "5678"]), path, 6)).rejects.toThrow(
      "download exceeded",
    );
    expect(existsSync(path)).toBe(false);
  });
});
