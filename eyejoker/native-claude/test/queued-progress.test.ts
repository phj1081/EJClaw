import { describe, expect, test } from "bun:test";
import { progressNonce, renderQueuedProgress } from "../src/queued-progress";

describe("queued progress", () => {
  test("uses one stable Discord-safe nonce per job", () => {
    const first = progressNonce("91ffd566-0e3d-4e13-988e-1b3cb7c0f30f");
    expect(first).toBe(progressNonce("91ffd566-0e3d-4e13-988e-1b3cb7c0f30f"));
    expect(first).not.toBe(progressNonce("c52b66ac-12b9-43a4-8d31-f3ae8232627f"));
    expect(first.length).toBeLessThanOrEqual(25);
  });

  test("explains global capacity without looking like a dead bot", () => {
    expect(
      renderQueuedProgress({
        running: 3,
        maxConcurrent: 3,
        sameConversationAhead: 0,
        prompt: "멤버십 점검",
      }),
    ).toBe("⏳ **대기 중** — 동시 작업 3/3\n└ 빈 자리 생기면 자동 시작 · 멤버십 점검");
  });

  test("explains same-thread serialization", () => {
    expect(
      renderQueuedProgress({
        running: 1,
        maxConcurrent: 3,
        sameConversationAhead: 1,
        prompt: "후속 작업",
      }),
    ).toBe("⏳ **대기 중** — 같은 스레드 앞 작업 1개\n└ 완료되면 자동 시작 · 후속 작업");
  });
});
