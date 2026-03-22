import { getLastHumanMessageTimestamp, isPairedRoomJid } from './db.js';
import { filterProcessableMessages } from './bot-message-filter.js';
import { normalizeStoredSeqCursor } from './message-cursor.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import { isTaskStatusControlMessage } from './task-watch-status.js';
import {
  type Channel,
  type NewMessage,
  type RegisteredGroup,
} from './types.js';

const BOT_COLLABORATION_WINDOW_MS = 12 * 60 * 60 * 1000;

export function advanceLastAgentCursor(
  lastAgentTimestamps: Record<string, string>,
  saveState: () => void,
  chatJid: string,
  cursorOrTimestamp: string | number,
): void {
  if (typeof cursorOrTimestamp === 'number') {
    lastAgentTimestamps[chatJid] = String(cursorOrTimestamp);
  } else {
    lastAgentTimestamps[chatJid] = normalizeStoredSeqCursor(
      cursorOrTimestamp,
      chatJid,
    );
  }
  saveState();
}

export function createImplicitContinuationTracker(idleTimeout: number) {
  const implicitContinuationUntil = new Map<string, number>();

  return {
    open(chatJid: string): void {
      if (idleTimeout <= 0) return;
      implicitContinuationUntil.set(chatJid, Date.now() + idleTimeout);
    },

    has(chatJid: string, messages: NewMessage[]): boolean {
      const until = implicitContinuationUntil.get(chatJid);
      if (!until) return false;
      if (Date.now() > until) {
        implicitContinuationUntil.delete(chatJid);
        return false;
      }
      return messages.some((message) => message.is_from_me !== true);
    },
  };
}

export function shouldSkipBotOnlyCollaboration(
  chatJid: string,
  messages: NewMessage[],
): boolean {
  if (isPairedRoomJid(chatJid)) return false;
  const allFromBots = messages.every(
    (message) => message.is_from_me || !!message.is_bot_message,
  );
  if (!allFromBots) return false;
  const lastHuman = getLastHumanMessageTimestamp(chatJid);
  if (!lastHuman) return true;
  return (
    Date.now() - new Date(lastHuman).getTime() > BOT_COLLABORATION_WINDOW_MS
  );
}

export function hasAllowedTrigger(opts: {
  chatJid: string;
  messages: NewMessage[];
  group: RegisteredGroup;
  triggerPattern: RegExp;
  hasImplicitContinuationWindow: (
    chatJid: string,
    messages: NewMessage[],
  ) => boolean;
}): boolean {
  const {
    chatJid,
    messages,
    group,
    triggerPattern,
    hasImplicitContinuationWindow,
  } = opts;

  if (group.isMain === true || group.requiresTrigger === false) {
    return true;
  }

  const allowlistCfg = loadSenderAllowlist();
  const hasTrigger = messages.some(
    (message) =>
      triggerPattern.test(message.content.trim()) &&
      (message.is_from_me ||
        isTriggerAllowed(chatJid, message.sender, allowlistCfg)),
  );
  return hasTrigger || hasImplicitContinuationWindow(chatJid, messages);
}

export function getProcessableMessages(
  chatJid: string,
  messages: Parameters<typeof filterProcessableMessages>[0],
  channel?: Channel,
) {
  return filterProcessableMessages(
    messages,
    isPairedRoomJid(chatJid),
    channel?.isOwnMessage?.bind(channel),
  ).filter((message) => !isTaskStatusControlMessage(message.content));
}

export function filterLoopingPairedBotMessages(
  chatJid: string,
  messages: Parameters<typeof filterProcessableMessages>[0],
  failureText: string,
) {
  if (!isPairedRoomJid(chatJid)) return messages;

  return messages.filter(
    (message) =>
      !(message.is_bot_message && message.content.trim() === failureText),
  );
}
