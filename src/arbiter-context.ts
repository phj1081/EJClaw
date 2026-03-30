import { getRecentChatMessages } from './db.js';
import { formatMessages } from './router.js';
import type { NewMessage } from './types.js';

export function buildArbiterContextPrompt(args: {
  chatJid: string;
  taskId: string;
  roundTripCount: number;
  timezone: string;
  recentTurnLimit?: number;
  /** Pre-labeled messages. If provided, skips DB fetch. */
  messages?: NewMessage[];
}): string {
  const {
    chatJid,
    taskId,
    roundTripCount,
    timezone,
    recentTurnLimit = 20,
  } = args;

  const recentMessages =
    args.messages ?? getRecentChatMessages(chatJid, recentTurnLimit);
  const conversationContext = formatMessages(recentMessages, timezone);

  return [
    `<arbiter-context>`,
    `<task-id>${taskId}</task-id>`,
    `<round-trips>${roundTripCount}</round-trips>`,
    `<reason>Deadlock detected: owner and reviewer exchanged ${roundTripCount} rounds without resolution</reason>`,
    `</arbiter-context>`,
    ``,
    `<conversation-history>`,
    conversationContext,
    `</conversation-history>`,
    ``,
    `Review the conversation above and render your verdict.`,
  ].join('\n');
}
