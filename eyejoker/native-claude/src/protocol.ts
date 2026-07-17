import type { ClaudeExecution, RouteConfig } from "./types";
import { appendAttachmentContext } from "./bridge-utils";
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

export function nativeBridgeSystemPrompt(route: RouteConfig): string {
  const lines = [
    "호스트가 최종 답변을 현재 대화에 자동 전달한다. Discord·send_message·MCP 전송 도구를 찾거나 호출하거나 전송 방식을 설명하지 마.",
    "생성 파일은 최종 답변 끝에 파일마다 단독 줄 MEDIA:/absolute/path로 적어. 사용자 선택이 꼭 필요할 때만 AskUserQuestion을 사용해.",
    "직접 만든 PR의 CI·리뷰·merge 후속 감시가 필요할 때만 단독 줄 PR_WATCH: https://github.com/owner/repo/pull/123을 적어.",
    "기존 변경을 보존하고 실제 확인한 실행 결과만 보고해.",
    "확인·추적 요청은 읽기 전용으로 원인부터 설명하고 승인 전 수정하지 마. 싹 처리·올리자·추천대로·ㄱㄱ는 제안한 전체 실행 승인이다.",
  ];
  if (route.instructions) lines.push(`범위: ${route.instructions}`);
  return lines.join("\n");
}

export function buildGoalPrompt(
  _route: RouteConfig,
  userPrompt: string,
  attachmentPaths: string[],
  recoveryReason: string | null,
): string {
  const lines = [userPrompt];
  if (recoveryReason) {
    lines.push(
      "",
      `[호스트 복구: ${recoveryReason}] 기존 변경을 버리지 말고 현재 상태에서 이어서 완수해.`,
    );
  }
  return appendAttachmentContext(lines.join("\n"), attachmentPaths);
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
    "--settings",
    JSON.stringify({
      enabledPlugins: {
        "agentmemory@agentmemory": false,
        "discord@claude-plugins-official": false,
      },
    }),
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--strict-mcp-config",
    "--append-system-prompt",
    nativeBridgeSystemPrompt(route),
    "--name",
    `native-${route.id}`,
  ];
  if (route.mixedAgents === true) args.push("--agents", JSON.stringify(defaultAgents));
  if (route.fallbackModel) args.push("--fallback-model", route.fallbackModel);
  if (resume && forkSession) args.push("--fork-session");
  args.push(resume ? "--resume" : "--session-id", sessionId);
  return {
    args,
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKENS: "",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ...(route.memoryProject ? { AGENTMEMORY_PROJECT_NAME: route.memoryProject } : {}),
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
