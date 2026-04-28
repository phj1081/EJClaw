import type { DashboardRoomActivity } from './api';

type RoomMessage = DashboardRoomActivity['messages'][number];
type RoomOutput = NonNullable<
  DashboardRoomActivity['pairedTask']
>['outputs'][number];

export type RoomThreadEntry = {
  id: string;
  senderName: string;
  content: string;
  attachments?: RoomMessage['attachments'];
  timestamp: string;
  isFromMe: boolean;
  isBotMessage: boolean;
  sourceKind: string;
  verdict?: string | null;
  turnNumber?: number;
};

const WATCHER_RE =
  /^\s*(?:CI 완료|Build |Deploy |Lint |Release |\[CI\]|\[Watcher\]|GitHub Actions)/i;

export function isInternalProtocolPayload(
  content: string | null | undefined,
): boolean {
  if (!content) return false;
  if (/<\/?(sub-agent[-\w]*|tool-call|internal)\b/i.test(content)) return true;
  if (/"author"\s*:\s*"[^"]+"\s*,\s*"recipient"\s*:\s*"[^"]+"/.test(content)) {
    return true;
  }
  return false;
}

export function isWatcherRoomMessage(message: RoomMessage): boolean {
  return message.sourceKind === 'bot' && WATCHER_RE.test(message.content);
}

function isThreadChatMessage(message: RoomMessage): boolean {
  if (isInternalProtocolPayload(message.content)) return false;
  if (isWatcherRoomMessage(message)) return false;
  return (
    message.sourceKind === 'human' ||
    message.sourceKind === 'ipc_injected_human' ||
    message.sourceKind === 'trusted_external_bot' ||
    message.sourceKind === 'bot'
  );
}

function toMessageEntry(message: RoomMessage): RoomThreadEntry {
  return {
    id: message.id,
    senderName: message.senderName,
    content: message.content,
    attachments: message.attachments,
    timestamp: message.timestamp,
    isFromMe: message.isFromMe,
    isBotMessage: message.isBotMessage,
    sourceKind: message.sourceKind,
  };
}

function toOutputEntry(output: RoomOutput): RoomThreadEntry | null {
  if (isInternalProtocolPayload(output.outputText)) return null;
  return {
    id: `out:${output.id}`,
    senderName: output.role,
    content: output.outputText,
    attachments: output.attachments,
    timestamp: output.createdAt,
    isFromMe: false,
    isBotMessage: true,
    sourceKind: 'agent_output',
    verdict: output.verdict,
    turnNumber: output.turnNumber,
  };
}

function messageKey(message: { content: string; senderName: string }): string {
  return `${message.senderName}\u0001${message.content}`;
}

function normalizeForDedupe(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const MIN_SUBSTRING_DEDUPE_LENGTH = 40;
const BOT_CHUNK_MERGE_WINDOW_MS = 15_000;
const STATUS_OUTPUT_PREFIX_RE =
  /^(?:STEP_DONE|TASK_DONE|DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)\b/;

function isDuplicateOutputMessage(
  message: RoomThreadEntry,
  outputEntries: RoomThreadEntry[],
): boolean {
  if (message.sourceKind !== 'bot') return false;
  const messageText = normalizeForDedupe(message.content);
  if (!messageText) return false;
  const messageTime = new Date(message.timestamp).getTime();

  return outputEntries.some((output) => {
    const outputText = normalizeForDedupe(output.content);
    if (!outputText) return false;
    const contentMatches =
      outputText === messageText ||
      outputText.startsWith(messageText) ||
      messageText.startsWith(outputText) ||
      (messageText.length >= MIN_SUBSTRING_DEDUPE_LENGTH &&
        outputText.includes(messageText)) ||
      (outputText.length >= MIN_SUBSTRING_DEDUPE_LENGTH &&
        messageText.includes(outputText));
    if (!contentMatches) return false;
    const outputTime = new Date(output.timestamp).getTime();
    if (!Number.isFinite(messageTime) || !Number.isFinite(outputTime)) {
      return true;
    }
    return Math.abs(outputTime - messageTime) <= 120_000;
  });
}

function entryTimeMs(entry: RoomThreadEntry): number | null {
  const time = new Date(entry.timestamp).getTime();
  return Number.isFinite(time) ? time : null;
}

function shouldMergeAdjacentBotChunk(
  previous: RoomThreadEntry,
  next: RoomThreadEntry,
): boolean {
  if (
    previous.sourceKind === 'agent_output' ||
    next.sourceKind === 'agent_output'
  ) {
    return false;
  }
  if (previous.senderName !== next.senderName) return false;
  if (previous.sourceKind !== next.sourceKind) return false;
  if (!previous.isBotMessage || !next.isBotMessage) return false;
  if (STATUS_OUTPUT_PREFIX_RE.test(next.content.trimStart())) return false;
  const previousTime = entryTimeMs(previous);
  const nextTime = entryTimeMs(next);
  if (previousTime === null || nextTime === null) {
    return previous.timestamp === next.timestamp;
  }
  return Math.abs(nextTime - previousTime) <= BOT_CHUNK_MERGE_WINDOW_MS;
}

function mergeEntryContent(left: string, right: string): string {
  const trimmedLeft = left.trimEnd();
  const trimmedRight = right.trimStart();
  if (!trimmedLeft) return trimmedRight;
  if (!trimmedRight) return trimmedLeft;
  return `${trimmedLeft}\n\n${trimmedRight}`;
}

function mergeAdjacentBotChunks(entries: RoomThreadEntry[]): RoomThreadEntry[] {
  const merged: RoomThreadEntry[] = [];
  for (const entry of entries) {
    const previous = merged.at(-1);
    if (previous && shouldMergeAdjacentBotChunk(previous, entry)) {
      previous.id = `${previous.id}+${entry.id}`;
      previous.content = mergeEntryContent(previous.content, entry.content);
      previous.verdict ??= entry.verdict;
      previous.turnNumber ??= entry.turnNumber;
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

export function buildRoomThreadEntries({
  messages,
  outputs,
  pendingMessages = [],
}: {
  messages: RoomMessage[];
  outputs: RoomOutput[];
  pendingMessages?: RoomMessage[];
}): RoomThreadEntry[] {
  const confirmedSet = new Set(messages.map(messageKey));
  const outputEntries = outputs
    .map(toOutputEntry)
    .filter((entry): entry is RoomThreadEntry => Boolean(entry));
  const chatEntries = messages
    .filter(isThreadChatMessage)
    .map(toMessageEntry)
    .filter((entry) => !isDuplicateOutputMessage(entry, outputEntries));
  const optimisticPending = pendingMessages
    .filter((message) => !confirmedSet.has(messageKey(message)))
    .filter((message) => !isInternalProtocolPayload(message.content))
    .map(toMessageEntry);

  const entries = [...chatEntries, ...optimisticPending, ...outputEntries].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp),
  );
  return mergeAdjacentBotChunks(entries);
}
