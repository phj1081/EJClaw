import type { PermissionMode, RouteConfig } from "./types";

export type ControlCommand =
  | { kind: "setting"; field: "model" | "permissionMode" | "effort"; value: string | null }
  | { kind: "fork" }
  | { kind: "branches" }
  | { kind: "checkpoints" }
  | { kind: "useBranch"; prefix: string }
  | { kind: "reset" }
  | { kind: "settings" }
  | { kind: "raw"; prompt: string }
  | { kind: "background"; prompt: string }
  | { kind: "rewindPreview"; checkpoint: string }
  | { kind: "rewindApply"; operationId: string }
  | { kind: "unsupported"; message: string }
  | { kind: "help" };

const permissionModes = new Set<PermissionMode>([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
]);
const efforts = new Set<RouteConfig["effort"]>(["low", "medium", "high", "xhigh", "max"]);
const rawAliases = new Set(["compact", "context", "usage", "review", "security-review", "init", "clear"]);

export function parseControlCommand(content: string): ControlCommand | null {
  const trimmed = content.trim();
  const match = /^!(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const command = match[1]!.toLowerCase();
  const argument = (match[2] ?? "").trim();

  if (command === "model") {
    if (!argument) return { kind: "unsupported", message: "사용법: !model <model|default>" };
    return { kind: "setting", field: "model", value: argument === "default" ? null : argument };
  }
  if (command === "permission") {
    if (argument === "default") return { kind: "setting", field: "permissionMode", value: null };
    if (!permissionModes.has(argument as PermissionMode)) {
      return { kind: "unsupported", message: `permission mode 오류: ${argument || "(없음)"}` };
    }
    return { kind: "setting", field: "permissionMode", value: argument };
  }
  if (command === "effort") {
    if (argument === "default") return { kind: "setting", field: "effort", value: null };
    if (!efforts.has(argument as RouteConfig["effort"])) {
      return { kind: "unsupported", message: `effort 오류: ${argument || "(없음)"}` };
    }
    return { kind: "setting", field: "effort", value: argument };
  }
  if (command === "fork") return { kind: "fork" };
  if (command === "branch") {
    if (argument === "list") return { kind: "branches" };
    const use = /^use\s+(\S+)$/.exec(argument);
    return use
      ? { kind: "useBranch", prefix: use[1]! }
      : { kind: "unsupported", message: "사용법: !branch list | !branch use <session-prefix>" };
  }
  if (command === "checkpoint") {
    return argument === "list"
      ? { kind: "checkpoints" }
      : { kind: "unsupported", message: "사용법: !checkpoint list" };
  }
  if (command === "reset") return { kind: "reset" };
  if (command === "settings") return { kind: "settings" };
  if (command === "help") return { kind: "help" };
  if (command === "background") {
    return argument
      ? { kind: "background", prompt: argument }
      : { kind: "unsupported", message: "사용법: !background <작업>" };
  }
  if (command === "claude") {
    return argument.startsWith("/")
      ? { kind: "raw", prompt: argument }
      : { kind: "unsupported", message: "사용법: !claude /<slash-command>" };
  }
  if (rawAliases.has(command)) return { kind: "raw", prompt: `/${command}${argument ? ` ${argument}` : ""}` };
  if (command === "rewind") {
    const preview = /^preview\s+(\S+)$/.exec(argument);
    if (preview) return { kind: "rewindPreview", checkpoint: preview[1]! };
    const apply = /^apply\s+(\S+)$/.exec(argument);
    return apply
      ? { kind: "rewindApply", operationId: apply[1]! }
      : { kind: "unsupported", message: "사용법: !rewind preview <user-message-uuid> | !rewind apply <operation-id>" };
  }
  return null;
}

export type MessageEditPromptDecision =
  | { ok: true; prompt: string }
  | { ok: false; message: string };

export function parseMessageEditPrompt(content: string, existingRawPrompt: boolean): MessageEditPromptDecision {
  if (existingRawPrompt || parseControlCommand(content)) {
    return {
      ok: false,
      message: "Claude control/raw 명령은 수정할 수 없어. 원본을 삭제하거나 새 메시지로 다시 보내줘.",
    };
  }
  return { ok: true, prompt: content };
}

export type IngressPromptDecision =
  | { ok: true; prompt: string }
  | { ok: false; message: string };

export function prepareIngressPrompt(input: {
  promptText: string;
  rawPrompt: boolean;
  attachmentCount: number;
  attachmentPaths: string[];
  attachmentErrors: string[];
}): IngressPromptDecision {
  if (input.rawPrompt && (input.attachmentCount > 0 || input.attachmentErrors.length > 0)) {
    return {
      ok: false,
      message: "raw Claude 명령에는 첨부를 같이 보낼 수 없어. 명령과 첨부 작업을 각각 새 메시지로 보내줘.",
    };
  }
  let prompt = input.promptText;
  if (!prompt && input.attachmentPaths.length > 0) prompt = "첨부 파일을 확인하고 필요한 작업을 수행해.";
  if (input.attachmentErrors.length > 0) {
    prompt += `\n\n첨부 다운로드 오류:\n${input.attachmentErrors.join("\n")}`;
  }
  return { ok: true, prompt };
}
