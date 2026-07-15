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
  });

  test("waits for a conversation text answer and clears the pending question", async () => {
    const broker = new QuestionBroker();
    const waiting = broker.wait(
      "job-1",
      "route:thread",
      { question: "A/B?", choices: ["A", "B"] },
      async () => "discord-question-1",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broker.hasPending("route:thread")).toBe(true);
    expect(broker.answerConversation("route:thread", "B")).toBe(true);
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
    expect(broker.answerConversation("conversation-persist", "예")).toBe(true);
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

  test("persists an early text answer even before the Discord post resolves", async () => {
    const broker = new QuestionBroker();
    let releasePost!: () => void;
    const posted = new Promise<void>((resolve) => (releasePost = resolve));
    const persisted: string[] = [];
    const waiting = broker.wait(
      "job-early",
      "route:early",
      { question: "계속?", choices: ["예", "아니오"] },
      async () => {
        await posted;
        return "discord-late-question";
      },
      (answer) => persisted.push(answer),
    );

    expect(broker.answerConversation("route:early", "예")).toBe(true);
    expect(await waiting).toBe("예");
    expect(persisted).toEqual(["예"]);
    releasePost();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broker.messageIdForConversation("route:early")).toBeNull();
  });

  test("maps a reaction on the question message to its choice", async () => {
    const broker = new QuestionBroker();
    const waiting = broker.wait(
      "job-2",
      "route:thread-2",
      { question: "선택?", choices: ["첫째", "둘째"] },
      async () => "discord-question-2",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broker.answerReaction("discord-question-2", "2️⃣")).toBe(true);
    expect(await waiting).toBe("둘째");
    expect(renderInteractiveQuestion({ question: "선택?", choices: ["첫째", "둘째"] })).toContain("1️⃣ 첫째");
  });
});
