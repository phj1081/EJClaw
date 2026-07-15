import type { InteractiveQuestion } from "./types";

const PREFIX = "DISCORD_QUESTION:";
export const QUESTION_REACTIONS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"] as const;
const QUESTION_BUTTON_PREFIX = "claude-question";

export function questionButtonId(interactionId: string, choiceIndex: number): string {
  return `${QUESTION_BUTTON_PREFIX}:${interactionId}:${choiceIndex}`;
}

export function parseQuestionButtonId(customId: string): { interactionId: string; choiceIndex: number } | null {
  const match = /^claude-question:([0-9a-f-]{36}):([0-3])$/i.exec(customId);
  if (!match) return null;
  return { interactionId: match[1]!, choiceIndex: Number(match[2]) };
}

interface PendingQuestion {
  jobId: string;
  conversationKey: string;
  question: InteractiveQuestion;
  messageId: string | null;
  settled: boolean;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  persist?: (answer: string) => void;
}

export function renderInteractiveQuestion(question: InteractiveQuestion): string {
  const lines = ["❓ **Claude 질문**", question.question];
  question.choices.forEach((choice, index) => lines.push(`${QUESTION_REACTIONS[index]} ${choice}`));
  lines.push("", question.choices.length > 0 ? "메시지로 답하거나 번호 reaction을 눌러줘." : "메시지로 답해줘.");
  return lines.join("\n");
}

export class QuestionBroker {
  private readonly byConversation = new Map<string, PendingQuestion>();
  private readonly byMessage = new Map<string, PendingQuestion>();
  private readonly byJob = new Map<string, PendingQuestion>();

  wait(
    jobId: string,
    conversationKey: string,
    question: InteractiveQuestion,
    post: () => Promise<string>,
    persist?: (answer: string) => void,
  ): Promise<string> {
    if (this.byConversation.has(conversationKey)) {
      return Promise.reject(new Error(`question already pending: ${conversationKey}`));
    }
    let resolveAnswer!: (answer: string) => void;
    let rejectAnswer!: (error: Error) => void;
    const answer = new Promise<string>((resolve, reject) => {
      resolveAnswer = resolve;
      rejectAnswer = reject;
    });
    const pending: PendingQuestion = {
      jobId,
      conversationKey,
      question,
      messageId: null,
      settled: false,
      resolve: resolveAnswer,
      reject: rejectAnswer,
    };
    if (persist) pending.persist = persist;
    this.byConversation.set(conversationKey, pending);
    this.byJob.set(jobId, pending);
    void post()
      .then((messageId) => {
        if (pending.settled) return;
        pending.messageId = messageId;
        this.byMessage.set(messageId, pending);
      })
      .catch((error) => this.rejectPending(pending, error instanceof Error ? error : new Error(String(error))));
    return answer;
  }

  hasPending(conversationKey: string): boolean {
    return this.byConversation.has(conversationKey);
  }

  answerConversation(conversationKey: string, answer: string): boolean {
    const pending = this.byConversation.get(conversationKey);
    return pending ? this.resolvePending(pending, answer) : false;
  }

  messageIdForConversation(conversationKey: string): string | null {
    return this.byConversation.get(conversationKey)?.messageId ?? null;
  }

  answerMessage(messageId: string, answer: string): boolean {
    const pending = this.byMessage.get(messageId);
    return pending ? this.resolvePending(pending, answer) : false;
  }

  answerReaction(messageId: string, emoji: string): boolean {
    const pending = this.byMessage.get(messageId);
    if (!pending) return false;
    const index = QUESTION_REACTIONS.indexOf(emoji as (typeof QUESTION_REACTIONS)[number]);
    const choice = index >= 0 ? pending.question.choices[index] : undefined;
    return choice ? this.resolvePending(pending, choice) : false;
  }

  cancelJob(jobId: string, reason = "question cancelled"): boolean {
    const pending = this.byJob.get(jobId);
    if (!pending) return false;
    this.rejectPending(pending, new Error(reason));
    return true;
  }

  private resolvePending(pending: PendingQuestion, answer: string): boolean {
    const value = answer.trim();
    if (!value || pending.settled) return false;
    try {
      pending.persist?.(value);
    } catch (error) {
      this.rejectPending(pending, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    pending.settled = true;
    this.cleanup(pending);
    pending.resolve(value);
    return true;
  }

  private rejectPending(pending: PendingQuestion, error: Error): void {
    if (pending.settled) return;
    pending.settled = true;
    this.cleanup(pending);
    pending.reject(error);
  }

  private cleanup(pending: PendingQuestion): void {
    this.byConversation.delete(pending.conversationKey);
    this.byJob.delete(pending.jobId);
    if (pending.messageId) this.byMessage.delete(pending.messageId);
  }
}

export function parseInteractiveQuestion(result: string): InteractiveQuestion | null {
  const lines = result.split("\n").map((value) => value.trim());
  let line: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.startsWith(PREFIX)) {
      line = lines[index];
      break;
    }
  }
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(PREFIX.length)) as Record<string, unknown>;
    if (typeof parsed.question !== "string") return null;
    const question = parsed.question.trim();
    if (!question || question.length > 1_000) return null;
    if (!Array.isArray(parsed.choices) || parsed.choices.length > 4) return null;
    const choices = parsed.choices.map((choice) => (typeof choice === "string" ? choice.trim() : ""));
    if (choices.some((choice) => !choice || choice.length > 200)) return null;
    return { question, choices };
  } catch {
    return null;
  }
}

export function streamUserEvent(content: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}
