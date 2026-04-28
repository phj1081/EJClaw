import type { DashboardRoomActivity } from './api';

type RoomMessage = DashboardRoomActivity['messages'][number];
type RoomOutput = NonNullable<
  DashboardRoomActivity['pairedTask']
>['outputs'][number];

export type RoomThreadEntry = {
  id: string;
  senderName: string;
  content: string;
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
      messageText.startsWith(outputText);
    if (!contentMatches) return false;
    const outputTime = new Date(output.timestamp).getTime();
    if (!Number.isFinite(messageTime) || !Number.isFinite(outputTime)) {
      return true;
    }
    return Math.abs(outputTime - messageTime) <= 120_000;
  });
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

  return [...chatEntries, ...optimisticPending, ...outputEntries].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
}
