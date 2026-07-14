import type { ClaudeExecution, RouteConfig } from "./types";

const defaultAgents = {
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
  const condition =
    "아래 사용자 요청을 실제 산출물로 완수한다. 요청 범위의 수정과 관련 테스트·빌드·런타임 검증을 실행하고, 승인된 Git/PR/CI/배포 후속이 있으면 끝까지 처리한다. 계획·진행 보고만 하고 멈추지 않는다. 진짜 외부 블로커가 증명되거나 20턴/6시간에 도달하면 중단하고 증거를 보고한다.";
  const lines = [
    `/goal ${condition}`,
    "",
    "너는 눈쟁이의 신뢰된 프로젝트 코딩 에이전트다. 한국어 반말, 결론 먼저.",
    "기존 사용자 변경을 보존하고, 추측한 결과나 실행하지 않은 테스트를 성공했다고 쓰지 마.",
    "중간 진행 메시지는 transport가 담당하므로 최종 결과 또는 실제 블로커만 간결하게 반환해.",
    "완료 판단은 자연어 약속이 아니라 diff, 테스트, 커밋, PR, CI, 배포/런타임 증거로 해.",
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
  prompt: string,
  sessionId: string,
  resume: boolean,
): { args: string[]; env: Record<string, string> } {
  const args = [
    "-p",
    prompt,
    "--model",
    route.model,
    "--permission-mode",
    route.permissionMode,
    "--effort",
    route.effort,
    "--output-format",
    "json",
    "--name",
    `native-${route.id}`,
  ];
  if (route.mixedAgents !== false) args.push("--agents", JSON.stringify(defaultAgents));
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

function jsonCandidates(stdout: string): unknown[] {
  const candidates: unknown[] = [];
  const text = stdout.trim();
  if (!text) return candidates;
  try {
    candidates.push(JSON.parse(text));
  } catch {
    for (const line of text.split("\n")) {
      try {
        candidates.push(JSON.parse(line));
      } catch {
        // Non-JSON diagnostics are ignored; stderr is retained separately.
      }
    }
  }
  return candidates;
}

export function parseClaudeOutput(stdout: string, stderr: string, exitCode: number): ClaudeExecution {
  const values = jsonCandidates(stdout);
  let result = "";
  let sessionId = "";
  let isError = exitCode !== 0;
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (typeof item.session_id === "string") sessionId = item.session_id;
    if (typeof item.result === "string") result = item.result;
    if (item.is_error === true || item.subtype === "error") isError = true;
  }
  if (!result) result = stdout.trim() || stderr.trim() || "(empty Claude result)";
  return {
    ok: !isError,
    result: result.slice(0, 16000),
    sessionId,
    stderr: stderr.slice(0, 8000),
    exitCode,
  };
}

export function formatProgressMessage(activity: string, elapsedSeconds: number): string {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsed = minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
  return `⏳ **작업 중** — ${elapsed}\n└ ${activity}`;
}

export function formatFinalMessage(
  ownerId: string,
  ok: boolean,
  body: string,
  elapsedSeconds: number,
): string {
  const clean = body.replace(new RegExp(`<@!?${ownerId}>`, "g"), "").trim();
  return `<@${ownerId}> ${ok ? "✅" : "⛔"} ${elapsedSeconds}s\n${clean || "(empty result)"}`;
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
