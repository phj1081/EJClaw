import { SERVICE_SESSION_SCOPE } from '../config.js';
import { AgentType, NewMessage } from '../types.js';

import { requireDatabase } from './runtime-database.js';
import {
  type MemoryRecord,
  type MemoryScopeKind,
  type MemorySourceKind,
  type RecallMemoryQuery,
  archiveMemoryInDatabase,
  enforceMemoryBoundsInDatabase,
  expireStaleMemoriesInDatabase,
  recallMemoriesFromDatabase,
  rememberMemoryInDatabase,
  touchMemoriesInDatabase,
} from './memories.js';
import {
  type ChatInfo,
  getAllChatsFromDatabase,
  getLastHumanMessageContentFromDatabase,
  getLastHumanMessageSenderFromDatabase,
  getLastHumanMessageTimestampFromDatabase,
  getLatestMessageSeqAtOrBeforeFromDatabase,
  getMessagesSinceFromDatabase,
  getMessagesSinceSeqFromDatabase,
  getNewMessagesBySeqFromDatabase,
  getNewMessagesFromDatabase,
  getRecentChatMessagesFromDatabase,
  getRecentChatMessagesBatchFromDatabase,
  hasMessageInDatabase,
  hasRecentRestartAnnouncementInDatabase,
  storeChatMetadataInDatabase,
  storeMessageInDatabase,
} from './messages.js';
import {
  type CreateProducedWorkItemInput,
  type WorkItem,
  createProducedWorkItemInDatabase,
  getOpenWorkItemForChatFromDatabase,
  getOpenWorkItemFromDatabase,
  getRecentDeliveredWorkItemsForChatFromDatabase,
  markWorkItemDeliveredInDatabase,
  markWorkItemDeliveryRetryInDatabase,
} from './work-items.js';

/** @internal - for tests only. */
export function _setMemoryTimestampsForTests(
  id: number,
  args: {
    createdAt?: string;
    lastUsedAt?: string | null;
    archivedAt?: string | null;
  },
): void {
  const db = requireDatabase();
  const existing = db
    .prepare(
      `SELECT created_at, last_used_at, archived_at
       FROM memories
       WHERE id = ?`,
    )
    .get(id) as
    | {
        created_at: string;
        last_used_at: string | null;
        archived_at: string | null;
      }
    | undefined;
  if (!existing) throw new Error(`Memory ${id} not found`);

  db.prepare(
    `UPDATE memories
     SET created_at = ?, last_used_at = ?, archived_at = ?
     WHERE id = ?`,
  ).run(
    args.createdAt ?? existing.created_at,
    args.lastUsedAt === undefined ? existing.last_used_at : args.lastUsedAt,
    args.archivedAt === undefined ? existing.archived_at : args.archivedAt,
    id,
  );
}

export function touchMemories(ids: number[]): void {
  touchMemoriesInDatabase(requireDatabase(), ids);
}

export function archiveMemory(id: number): void {
  archiveMemoryInDatabase(requireDatabase(), id);
}

export function expireStaleMemories(args?: {
  scopeKind?: MemoryScopeKind;
  scopeKey?: string;
  now?: string;
}): number {
  return expireStaleMemoriesInDatabase(requireDatabase(), args);
}

export function enforceMemoryBounds(
  scopeKind: MemoryScopeKind,
  scopeKey: string,
): void {
  enforceMemoryBoundsInDatabase(requireDatabase(), scopeKind, scopeKey);
}

export function rememberMemory(input: {
  scopeKind: MemoryScopeKind;
  scopeKey: string;
  content: string;
  keywords?: string[];
  memoryKind?: string | null;
  sourceKind: MemorySourceKind;
  sourceRef?: string | null;
}): number {
  return rememberMemoryInDatabase(requireDatabase(), input);
}

export function recallMemories(query: RecallMemoryQuery): MemoryRecord[] {
  return recallMemoriesFromDatabase(requireDatabase(), query);
}

export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  storeChatMetadataInDatabase(
    requireDatabase(),
    chatJid,
    timestamp,
    name,
    channel,
    isGroup,
  );
}

export function getAllChats(): ChatInfo[] {
  return getAllChatsFromDatabase(requireDatabase());
}

export function storeMessage(msg: NewMessage): void {
  storeMessageInDatabase(requireDatabase(), msg);
}

export function hasMessage(chatJid: string, id: string): boolean {
  return hasMessageInDatabase(requireDatabase(), chatJid, id);
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  return getNewMessagesFromDatabase(
    requireDatabase(),
    jids,
    lastTimestamp,
    botPrefix,
    limit,
  );
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  return getMessagesSinceFromDatabase(
    requireDatabase(),
    chatJid,
    sinceTimestamp,
    botPrefix,
    limit,
  );
}

export function getLatestMessageSeqAtOrBefore(
  timestamp: string,
  chatJid?: string,
): number {
  return getLatestMessageSeqAtOrBeforeFromDatabase(
    requireDatabase(),
    timestamp,
    chatJid,
  );
}

export function getNewMessagesBySeq(
  jids: string[],
  lastSeqCursor: string | number,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newSeqCursor: string } {
  return getNewMessagesBySeqFromDatabase(
    requireDatabase(),
    jids,
    lastSeqCursor,
    botPrefix,
    limit,
  );
}

export function getMessagesSinceSeq(
  chatJid: string,
  sinceSeqCursor: string | number,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  return getMessagesSinceSeqFromDatabase(
    requireDatabase(),
    chatJid,
    sinceSeqCursor,
    botPrefix,
    limit,
  );
}

export function getRecentChatMessages(
  chatJid: string,
  limit: number = 20,
): NewMessage[] {
  return getRecentChatMessagesFromDatabase(requireDatabase(), chatJid, limit);
}

export function getRecentChatMessagesBatch(
  chatJids: string[],
  limit: number = 8,
): Map<string, NewMessage[]> {
  return getRecentChatMessagesBatchFromDatabase(
    requireDatabase(),
    chatJids,
    limit,
  );
}

export function getLastHumanMessageTimestamp(chatJid: string): string | null {
  return getLastHumanMessageTimestampFromDatabase(requireDatabase(), chatJid);
}

export function getLastHumanMessageSender(chatJid: string): string | null {
  return getLastHumanMessageSenderFromDatabase(requireDatabase(), chatJid);
}

export function getLastHumanMessageContent(chatJid: string): string | null {
  return getLastHumanMessageContentFromDatabase(requireDatabase(), chatJid);
}

export function hasRecentRestartAnnouncement(
  chatJid: string,
  sinceTimestamp: string,
): boolean {
  return hasRecentRestartAnnouncementInDatabase(
    requireDatabase(),
    chatJid,
    sinceTimestamp,
  );
}

export function getOpenWorkItem(
  chatJid: string,
  agentType: AgentType = 'claude-code',
  serviceId: string = SERVICE_SESSION_SCOPE,
): WorkItem | undefined {
  return getOpenWorkItemFromDatabase(
    requireDatabase(),
    chatJid,
    agentType,
    serviceId,
  );
}

export function getOpenWorkItemForChat(
  chatJid: string,
  serviceId: string = SERVICE_SESSION_SCOPE,
): WorkItem | undefined {
  return getOpenWorkItemForChatFromDatabase(
    requireDatabase(),
    chatJid,
    serviceId,
  );
}

export function getRecentDeliveredWorkItemsForChat(
  chatJid: string,
  limit: number = 8,
): WorkItem[] {
  return getRecentDeliveredWorkItemsForChatFromDatabase(
    requireDatabase(),
    chatJid,
    limit,
  );
}

export function createProducedWorkItem(
  input: CreateProducedWorkItemInput,
): WorkItem {
  return createProducedWorkItemInDatabase(requireDatabase(), input);
}

export function markWorkItemDelivered(
  id: number,
  deliveryMessageId?: string | null,
): void {
  markWorkItemDeliveredInDatabase(requireDatabase(), id, deliveryMessageId);
}

export function markWorkItemDeliveryRetry(id: number, error: string): void {
  markWorkItemDeliveryRetryInDatabase(requireDatabase(), id, error);
}
