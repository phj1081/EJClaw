import { readFileSync, statSync } from "node:fs";

const MAX_PROMPT_BYTES = 1024 * 1024;

export function readSecurePromptFile(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("scheduled prompt must be a regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("scheduled prompt must have mode 600");
  if (stat.size > MAX_PROMPT_BYTES) throw new Error("scheduled prompt exceeds 1 MiB");
  const prompt = readFileSync(path, "utf8").trim();
  if (!prompt) throw new Error("scheduled prompt is empty");
  return prompt;
}

function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function scheduleIdentity(
  routeId: string,
  scheduleKey: string,
  date = new Date(),
  timeZone = "Asia/Seoul",
): { messageId: string; conversationKey: string } {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(scheduleKey)) {
    throw new Error("invalid CLAUDE_NATIVE_SCHEDULE_KEY");
  }
  return {
    messageId: `scheduled:${scheduleKey}:${localDate(date, timeZone)}`,
    conversationKey: `${routeId}:scheduled:${scheduleKey}`,
  };
}
