import { basename } from "node:path";

export function conversationKey(route: { id: string }, actualChannelId: string): string {
  return `${route.id}:${actualChannelId}`;
}

export function isSupportedMessageType(type: number): boolean {
  return type === 0 || type === 19;
}

export function stripBotMention(content: string, botId: string): string {
  return content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function sanitizeAttachmentName(name: string): string {
  const safe = basename(name).replace(/[^\p{L}\p{N}._-]+/gu, "_");
  return safe.replace(/^\.+/, "") || "attachment";
}
