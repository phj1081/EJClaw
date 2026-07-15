import type { ClaudeExecution, RouteConfig } from "./types";
import { formatElapsedKorean } from "./duration";
import { formatModelUsage } from "./model-visibility";
import { parseStreamJsonResult } from "./stream-progress";

export const defaultAgents = {
  "fable-worker": {
    description: "독립 구현·검증 작업을 수행하는 Fable 코딩 서브에이전트",
    prompt: "코드와 런타임 증거를 직접 확인하고 맡은 작업을 끝까지 구현·검증해라.",
    model: "claude-fable-5",
  },
  "gpt-worker": {
    description: "독립 구현·검증 또는 교차점검을 수행하는 GPT 코딩 서브에이전트",
    prompt: "요청 범위를 실제 소스와 실행 결과로 검증하고 구체적 산출물을 반환해라.",
    model: "gpt-5.6-sol",
  },
};

export function buildGoalPrompt(
  route: RouteConfig,
  userPrompt: string,
  attachmentPaths: string[],
  recoveryReason: string | null,
): string {
  const condition = "사용자 요청을 실제 산출물·테스트·필요 시 PR/CI 증거로 완수할 것. 계획만 하고 멈추지 말 것.";
  const lines = [
    `/goal ${condition}`,
    "",
    "너는 눈쟁이의 신뢰된 프로젝트 코딩 에이전트다. 한국어 반말, 결론 먼저.",
    "기존 사용자 변경을 보존하고, 추측한 결과나 실행하지 않은 테스트를 성공했다고 쓰지 마.",
    "완료 판단은 자연어 약속이 아니라 diff, 테스트, 커밋, PR, CI, 배포/런타임 증거로 해.",
    "요청이 길더라도 /goal 조건은 위 한 줄만 쓰고, 세부 작업 내용은 아래 사용자 요청을 따른다.",
    "진짜 외부 블로커가 증명되거나 20턴/6시간에 도달하면 중단하고 증거를 보고한다.",
    "Discord에 전달할 생성 파일이 있으면 최종 응답 끝에 파일마다 단독 줄 MEDIA:/absolute/path 형식으로 적어. 민감 파일은 절대 첨부하지 마.",
    "네가 이번 작업에서 직접 생성·소유하고 CI/리뷰/merge 후속 감시가 필요한 GitHub PR이 있으면 최종 응답 끝에 PR마다 단독 줄 PR_WATCH: https://github.com/owner/repo/pull/123 형식으로 적어. 단순 조사·리뷰 대상 PR에는 붙이지 마. bridge가 marker를 숨기고 내구성 watcher에 등록한다.",
    "진행에 사용자 선택이 반드시 필요하면 반드시 native AskUserQuestion 도구를 호출해. Discord bridge가 선택지를 버튼으로 보여주고 답변을 같은 세션에 반환한다.",
    'native AskUserQuestion 도구를 사용할 수 없는 경우에만 최종 응답 끝에 단독 한 줄 DISCORD_QUESTION:{"question":"질문","choices":["선택1","선택2"]}를 fallback으로 적어. 선택지는 최대 4개.',
  ];
  if (route.instructions) lines.push("", `프로젝트 범위:\n${route.instructions}`);
  if (recoveryReason) {
    lines.push(
      "",
      `호스트 복구 사유: ${recoveryReason}`,
      "이전 프로세스가 중단됐다. 현재 브랜치·작업트리·대화 기록을 먼저 확인하고 기존 변경을 버리지 말고 이어서 완수해.",
    );
  }
  if (attachmentPaths.length > 0) lines.push("", `첨부 파일 경로:\n${attachmentPaths.join("\n")}`);
  lines.push("", `사용자 요청:\n${userPrompt}`);
  return lines.join("\n");
}

export function buildClaudeInvocation(
  route: RouteConfig,
  _prompt: string,
  sessionId: string,
  resume: boolean,
  forkSession = false,
): { args: string[]; env: Record<string, string> } {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--replay-user-messages",
    "--model",
    route.model,
    "--permission-mode",
    route.permissionMode,
    "--effort",
    route.effort,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--name",
    `native-${route.id}`,
  ];
  if (route.mixedAgents !== false) args.push("--agents", JSON.stringify(defaultAgents));
  if (route.fallbackModel) args.push("--fallback-model", route.fallbackModel);
  if (resume && forkSession) args.push("--fork-session");
  args.push(resume ? "--resume" : "--session-id", sessionId);
  return {
    args,
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKENS: "",
      ANTHROPIC_AUTH_TOKEN: "",
    },
  };
}

export function parseClaudeOutput(stdout: string, stderr: string, exitCode: number): ClaudeExecution {
  const parsed = parseStreamJsonResult(stdout, stderr, exitCode);
  return {
    ok: parsed.ok,
    result: parsed.result,
    sessionId: parsed.sessionId,
    stderr: parsed.stderr,
    exitCode: parsed.exitCode,
    mainModel: parsed.mainModel,
    subagentModels: parsed.subagentModels,
  };
}

export function formatProgressMessage(activity: string, elapsedSeconds: number): string {
  return `⏳ **작업 중** — ${formatElapsedKorean(elapsedSeconds)}\n└ ${activity}`;
}

export function formatFinalMessage(
  ownerId: string,
  ok: boolean,
  body: string,
  elapsedSeconds: number,
  mainModel?: string | null,
  subagentModels: string[] = [],
): string {
  const clean = body.replace(new RegExp(`<@!?${ownerId}>`, "g"), "").trim();
  const status = ok ? `<@${ownerId}>` : `<@${ownerId}> ⛔ 실패`;
  const modelUsage = formatModelUsage(mainModel, subagentModels);
  const modelSuffix = modelUsage ? ` · ${modelUsage}` : "";
  return `${status} · 작업 시간 ${formatElapsedKorean(elapsedSeconds)}${modelSuffix}\n${clean || "결과 없음"}`;
}

export interface FinalChunkOptions {
  content: string;
  allowedMentions: { users: string[] } | { parse: [] };
}

export function buildFinalChunkOptions(ownerId: string, content: string, index: number): FinalChunkOptions {
  return {
    content,
    allowedMentions: index === 0 ? { users: [ownerId] } : { parse: [] },
  };
}

export function splitDiscordMessage(text: string, limit = 1900): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
