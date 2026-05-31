import { getMessagesSince, getRecentChatMessages } from './db.js';
import type { NewMessage, PairedTask } from './types.js';

export const TASK_USER_CONTEXT_START_SKEW_MS = 5_000;
const TASK_CONTEXT_MESSAGE_LIMIT = 200;
const NO_BOT_PREFIX_FILTER = '';

function taskContextStartTimestamp(task: PairedTask): string | null {
  const taskCreatedMs = Date.parse(task.created_at);
  if (!Number.isFinite(taskCreatedMs)) {
    return null;
  }
  return new Date(
    taskCreatedMs - TASK_USER_CONTEXT_START_SKEW_MS,
  ).toISOString();
}

export function getTaskContextMessages(
  chatJid: string,
  task: PairedTask,
): NewMessage[] {
  const sinceTimestamp = taskContextStartTimestamp(task);
  if (!sinceTimestamp) {
    return getRecentChatMessages(chatJid, 20);
  }
  const taskMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    NO_BOT_PREFIX_FILTER,
    TASK_CONTEXT_MESSAGE_LIMIT,
  );
  return taskMessages.length > 0
    ? taskMessages
    : getRecentChatMessages(chatJid, 20);
}
