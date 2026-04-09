import { isSessionCommandControlMessage } from './session-commands.js';
import { NewMessage } from './types.js';

const PAIRED_EXECUTION_CONTROL_MESSAGE_PATTERN =
  /^(?:<@\d+>\s+)?(?:✅ 작업 완료\.|⚠️ 자동 해결 불가 — 확인이 필요합니다\.|⚠️ 중재자 판단: 사람 개입이 필요합니다\.)$/;

function isPairedExecutionControlMessage(content: string): boolean {
  return PAIRED_EXECUTION_CONTROL_MESSAGE_PATTERN.test(content.trim());
}

/**
 * Filter messages before processing.
 * - Normal rooms: drop all bot messages.
 * - Paired rooms (allowBotMessages=true): keep other bot's messages,
 *   but drop messages authored by this service's own bot (via isOwnMessage).
 */
export function filterProcessableMessages(
  messages: NewMessage[],
  allowBotMessages: boolean,
  isOwnMessage?: (msg: NewMessage) => boolean,
): NewMessage[] {
  const withoutControlMessages = messages.filter(
    (message) =>
      !(
        message.is_bot_message &&
        (isSessionCommandControlMessage(message.content) ||
          isPairedExecutionControlMessage(message.content))
      ),
  );

  if (allowBotMessages) {
    // In paired rooms, allow other bot messages but filter own bot's output
    if (isOwnMessage) {
      return withoutControlMessages.filter((m) => !isOwnMessage(m));
    }
    return withoutControlMessages;
  }
  return withoutControlMessages.filter((message) => !message.is_bot_message);
}
