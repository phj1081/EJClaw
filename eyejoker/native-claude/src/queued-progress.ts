import { createHash } from "node:crypto";

export interface QueuedProgressInput {
  running: number;
  maxConcurrent: number;
  sameConversationAhead: number;
  prompt: string;
}

export function progressNonce(jobId: string): string {
  return `native-progress-${createHash("sha256").update(jobId).digest("hex").slice(0, 9)}`;
}

function promptPreview(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "요청";
  return firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine;
}

export function renderQueuedProgress(input: QueuedProgressInput): string {
  const preview = promptPreview(input.prompt);
  if (input.sameConversationAhead > 0) {
    return [
      `⏳ **대기 중** — 같은 스레드 앞 작업 ${input.sameConversationAhead}개`,
      `└ 완료되면 자동 시작 · ${preview}`,
    ].join("\n");
  }
  if (input.running >= input.maxConcurrent) {
    return [
      `⏳ **대기 중** — 동시 작업 ${input.running}/${input.maxConcurrent}`,
      `└ 빈 자리 생기면 자동 시작 · ${preview}`,
    ].join("\n");
  }
  return ["⏳ **접수됨** — 시작 준비 중", `└ 자동으로 작업 시작 · ${preview}`].join("\n");
}
