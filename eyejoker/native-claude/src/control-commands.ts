import type { PermissionMode, RouteConfig } from "./types";

export type ControlCommand =
  | { kind: "setting"; field: "model" | "permissionMode" | "effort"; value: string | null }
  | { kind: "fork" }
  | { kind: "reset" }
  | { kind: "settings" }
  | { kind: "raw"; prompt: string }
  | { kind: "background"; prompt: string }
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
    return {
      kind: "unsupported",
      message: "현재 Claude Code 설치본은 rewind/resume-session-at CLI를 제공하지 않아. !fork 또는 !reset을 써줘.",
    };
  }
  return null;
}
