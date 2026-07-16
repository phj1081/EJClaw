import { describe, expect, test } from "bun:test";
import {
  parseInteractiveQuestion,
  parseQuestionButtonId,
  questionButtonId,
  questionNonce,
  QuestionBroker,
  renderAnsweredInteractiveQuestion,
  renderInteractiveQuestion,
  textAnswerForQuestion,
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

  test("settles pending questions by Discord button or same-conversation text", async () => {
    const broker = new QuestionBroker();
    const waiting = broker.wait(
      "job-1",
      "route:thread",
      { question: "A/B?", choices: ["A", "B"] },
      async () => "discord-question-1",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broker.hasPending("route:thread")).toBe(true);
    expect(broker.answerConversation("route:other", "B")).toBe(false);
    expect(broker.answerMessage("discord-question-1", "B")).toBe(true);
    expect(await waiting).toBe("B");
    expect(broker.hasPending("route:thread")).toBe(false);

    const textWaiting = broker.wait(
      "job-2",
      "route:text",
      { question: "어떻게 할까?", choices: ["A", "B"] },
      async () => "discord-question-2",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broker.answerConversation("route:text", "가능하면 수정해줘")).toBe(true);
    expect(await textWaiting).toBe("가능하면 수정해줘");
  });

  test("allows free text for normal questions but requires an exact permission choice", () => {
    expect(textAnswerForQuestion({ question: "방법?", choices: ["A", "B"], kind: "question" }, " 다른 방법 ")).toBe(
      "다른 방법",
    );
    expect(
      textAnswerForQuestion(
        { question: "허용?", choices: ["이번만 허용", "거부"], kind: "permission" },
        "응, 허용해",
      ),
    ).toBeNull();
    expect(
      textAnswerForQuestion(
        { question: "허용?", choices: ["이번만 허용", "거부"], kind: "permission" },
        "이번만 허용",
      ),
    ).toBe("이번만 허용");
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

  test("renders a distinct answered state without the pending button instruction", () => {
    const rendered = renderAnsweredInteractiveQuestion(
      { question: "언제 재시작할까?", choices: ["60초 후", "나중에"] },
      "60초 후",
    );
    expect(rendered).toBe("❓ **Claude 질문**\n언제 재시작할까?\n\n✅ **선택 완료**\n60초 후");
    expect(rendered).not.toContain("아래 버튼으로 선택해줘.");
  });

  test("registers same-conversation text settlement without a reaction fallback", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(source).toContain("questionBroker.answerConversation(key, textAnswer)");
    expect(source).toContain("textAnswerForQuestion(pendingQuestion.question, promptText)");
    expect(source).not.toContain("questionBroker.answerReaction");
    expect(source).not.toContain('client.on("messageReactionAdd"');
    expect(source).toContain("progressBoards.get(job.id)?.resetAfterInteraction(question.toolUseId)");
  });
});
