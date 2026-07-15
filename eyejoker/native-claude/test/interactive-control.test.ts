import { describe, expect, test } from "bun:test";
import {
  parseInteractiveQuestion,
  parseQuestionButtonId,
  questionButtonId,
  questionNonce,
  QuestionBroker,
  renderInteractiveQuestion,
} from "../src/interactive-control";

describe("interactive Discord control protocol", () => {
  test("parses a bounded one-line question marker", () => {
    expect(
      parseInteractiveQuestion('작업 전에 확인 필요\nDISCORD_QUESTION:{"question":"배포할까?","choices":["예","아니오"]}'),
    ).toEqual({ question: "배포할까?", choices: ["예", "아니오"] });
  });

  test("rejects malformed or unbounded markers", () => {
    expect(parseInteractiveQuestion("DISCORD_QUESTION:not-json")).toBeNull();
    expect(
      parseInteractiveQuestion(`DISCORD_QUESTION:${JSON.stringify({ question: "q", choices: ["1", "2", "3", "4", "5"] })}`),
    ).toBeNull();
    expect(parseInteractiveQuestion('DISCORD_QUESTION:{"question":"open","choices":[]}')).toBeNull();
  });

  test("exposes only Discord button settlement for pending questions", async () => {
    const broker = new QuestionBroker();
    const waiting = broker.wait(
      "job-1",
      "route:thread",
      { question: "A/B?", choices: ["A", "B"] },
      async () => "discord-question-1",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broker.hasPending("route:thread")).toBe(true);
    expect((broker as unknown as { answerConversation?: unknown }).answerConversation).toBeUndefined();
    expect((broker as unknown as { answerReaction?: unknown }).answerReaction).toBeUndefined();
    expect(broker.answerMessage("discord-question-1", "B")).toBe(true);
    expect(await waiting).toBe("B");
    expect(broker.hasPending("route:thread")).toBe(false);
  });

  test("persists an answer synchronously before releasing the waiting SDK callback", async () => {
    const broker = new QuestionBroker();
    const order: string[] = [];
    const waiting = broker.wait(
      "job-persist",
      "conversation-persist",
      { question: "계속?", choices: ["예", "아니오"] },
      async () => "discord-persist",
      (answer) => order.push(`persist:${answer}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broker.answerMessage("discord-persist", "예")).toBe(true);
    const answer = await waiting;
    order.push(`resolved:${answer}`);
    expect(order).toEqual(["persist:예", "resolved:예"]);
  });

  test("encodes durable Discord button choices and resolves by question message", async () => {
    const interactionId = "11111111-1111-4111-8111-111111111111";
    const customId = questionButtonId(interactionId, 1);
    expect(parseQuestionButtonId(customId)).toEqual({ interactionId, choiceIndex: 1 });
    expect(parseQuestionButtonId("claude-question:bad:9")).toBeNull();

    const broker = new QuestionBroker();
    const waiting = broker.wait(
      "job-button",
      "route:button",
      { question: "선택?", choices: ["첫째", "둘째"] },
      async () => "discord-button-question",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broker.messageIdForConversation("route:button")).toBe("discord-button-question");
    expect(broker.answerMessage("discord-button-question", "둘째")).toBe(true);
    expect(await waiting).toBe("둘째");
  });

  test("uses a stable Discord-safe nonce per durable interaction", () => {
    const first = questionNonce("11111111-1111-4111-8111-111111111111");
    expect(first).toBe(questionNonce("11111111-1111-4111-8111-111111111111"));
    expect(first).toMatch(/^\d{1,25}$/);
    expect(first).not.toBe(questionNonce("22222222-2222-4222-8222-222222222222"));
  });

  test("renders a button-only question card without numbered reaction instructions", () => {
    const rendered = renderInteractiveQuestion({ question: "선택?", choices: ["첫째", "둘째"] });
    expect(rendered).toContain("아래 버튼으로 선택해줘.");
    expect(rendered).not.toContain("1️⃣");
    expect(rendered).not.toContain("reaction");
    expect(rendered).not.toContain("메시지로 답");
  });

  test("does not register text or reaction fallback handlers in the Discord bridge", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(source).not.toContain("questionBroker.answerConversation");
    expect(source).not.toContain('client.on("messageReactionAdd"');
    expect(source).not.toContain("question reaction failed");
    expect(source).toContain('message.react("👀")');
  });
});
