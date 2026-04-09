import { Database } from 'bun:sqlite';
import fs from 'fs';

import {
  ASSISTANT_NAME,
  ARBITER_AGENT_TYPE,
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  normalizeServiceId,
  OWNER_AGENT_TYPE,
  REVIEWER_AGENT_TYPE,
  SERVICE_ID,
  SERVICE_SESSION_SCOPE,
} from './config.js';
import {
  isValidGroupFolder,
  resolveTaskRuntimeIpcPath as resolveTaskRuntimeIpcPathFromGroup,
  resolveServiceTaskSessionsPath as resolveServiceTaskSessionsPathFromGroup,
  resolveTaskSessionsPath as resolveTaskSessionsPathFromGroup,
} from './group-folder.js';
import { logger } from './logger.js';
import {
  type RoomModeSource,
  type RoomRegistrationSnapshot,
  type StoredRoomSettings,
  buildRegisteredGroupFromStoredSettings,
  collectRegisteredAgentTypes,
  collectRegisteredAgentTypesForFolder,
  collectRoomRegistrationSnapshot,
  getLegacyRegisteredGroup,
  getLegacyRegisteredGroupRows,
  getStoredRoomRowsFromDatabase,
  getStoredRoomSettingsRowFromDatabase,
  inferOwnerAgentTypeFromRegisteredAgentTypes,
  inferRoomModeFromRegisteredAgentTypes,
  insertStoredRoomSettings,
  materializeRegisteredGroupsForRoom,
  normalizeRoomModeSource,
  normalizeStoredAgentType,
  parseRegisteredGroupRow,
  resolveStoredRoomCapabilityTypes,
  resolveAssignedRoomFolder,
  updateStoredRoomMetadata,
} from './db/room-registration.js';
import {
  initializeDatabaseSchema,
  migrateJsonStateFromFiles,
  openDatabaseFromFile,
  openInMemoryDatabase,
  openPersistentDatabase,
} from './db/bootstrap.js';
import {
  clearChannelOwnerLeaseInDatabase,
  getAllChannelOwnerLeasesFromDatabase,
  getChannelOwnerLeaseFromDatabase,
  setChannelOwnerLeaseInDatabase,
  type ChannelOwnerLeaseRow,
  type SetChannelOwnerLeaseInput,
} from './db/channel-owner-leases.js';
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
} from './db/memories.js';
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
  hasRecentRestartAnnouncementInDatabase,
  normalizeSeqCursor,
  storeChatMetadataInDatabase,
  storeMessageInDatabase,
} from './db/messages.js';
import {
  type CreateProducedWorkItemInput,
  type WorkItem,
  createProducedWorkItemInDatabase,
  getOpenWorkItemForChatFromDatabase,
  getOpenWorkItemFromDatabase,
  markWorkItemDeliveredInDatabase,
  markWorkItemDeliveryRetryInDatabase,
} from './db/work-items.js';
import {
  claimPairedTurnReservationInDatabase,
  clearPairedTaskExecutionLeasesForServiceInDatabase,
  clearExpiredPairedTaskExecutionLeasesInDatabase,
  clearPairedTaskExecutionLeasesInDatabase,
  clearPairedTurnReservationsInDatabase,
  type PairedTaskUpdates,
  createPairedTaskInDatabase,
  getLastBotFinalMessageFromDatabase,
  getLatestOpenPairedTaskForChatFromDatabase,
  getLatestPairedTaskForChatFromDatabase,
  getPairedProjectFromDatabase,
  getPairedTaskByIdFromDatabase,
  getPairedWorkspaceFromDatabase,
  listPairedWorkspacesForTaskFromDatabase,
  refreshPairedTaskExecutionLeaseInDatabase,
  releasePairedTaskExecutionLeaseInDatabase,
  reservePairedTurnReservationInDatabase,
  updatePairedTaskIfUnchangedInDatabase,
  updatePairedTaskInDatabase,
  upsertPairedProjectInDatabase,
  upsertPairedWorkspaceInDatabase,
} from './db/paired-state.js';
import {
  getLatestTurnNumberFromDatabase,
  getPairedTurnOutputsFromDatabase,
  insertPairedTurnOutputInDatabase,
} from './db/paired-turn-outputs.js';
import {
  type CompleteServiceHandoffCursorInput,
  type CreateServiceHandoffInput,
  type ServiceHandoff,
  claimServiceHandoffInDatabase,
  completeServiceHandoffAndAdvanceTargetCursorInDatabase,
  completeServiceHandoffInDatabase,
  createServiceHandoffInDatabase,
  failServiceHandoffInDatabase,
  getAllPendingServiceHandoffsFromDatabase,
  getPendingServiceHandoffsFromDatabase,
} from './db/service-handoffs.js';
import {
  getLastRespondingAgentTypeFromDatabase,
  getRouterStateForServiceFromDatabase,
  getRouterStateFromDatabase,
  setRouterStateForServiceInDatabase,
  setRouterStateInDatabase,
} from './db/router-state.js';
import {
  backfillChannelOwnerRoleMetadata,
  backfillPairedTaskRoleMetadata,
  backfillServiceHandoffServiceShadows,
  backfillStoredRoomSettings,
  backfillWorkItemServiceShadows,
  rebuildChannelOwnerCanonicalSchema,
  rebuildPairedTasksCanonicalSchema,
  rebuildServiceHandoffsCanonicalSchema,
  rebuildWorkItemsCanonicalSchema,
  resolveStablePairedTaskOwnerAgentType,
  resolveStableRoomRoleAgentType,
} from './db/legacy-rebuilds.js';
import {
  deleteAllSessionsForGroupFromDatabase,
  deleteSessionFromDatabase,
  getAllSessionsForAgentTypeFromDatabase,
  getSessionFromDatabase,
  setSessionInDatabase,
} from './db/sessions.js';
import { type SchemaMigrationHooks, tableHasColumn } from './db/schema.js';
import {
  type CreateScheduledTaskInput,
  type ScheduledTaskStatusTrackingUpdates,
  type ScheduledTaskUpdates,
  createTaskInDatabase,
  findDuplicateCiWatcherInDatabase,
  getAllTasksFromDatabase,
  getDueTasksFromDatabase,
  getRecentConsecutiveErrorsFromDatabase,
  getTaskByIdFromDatabase,
  getTasksForGroupFromDatabase,
  hasActiveCiWatcherForChatInDatabase,
  logTaskRunInDatabase,
  updateTaskAfterRunInDatabase,
  updateTaskInDatabase,
  updateTaskStatusTrackingInDatabase,
} from './db/tasks.js';
import {
  inferAgentTypeFromServiceShadow,
  resolveRoleServiceShadow,
} from './role-service-shadow.js';
import { getTaskRuntimeTaskId } from './task-watch-status.js';
import {
  NewMessage,
  AgentType,
  PairedProject,
  PairedRoomRole,
  RoomMode,
  PairedTask,
  PairedTurnReservationIntentKind,
  PairedTurnOutput,
  PairedWorkspace,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

export { inferRoomModeFromRegisteredAgentTypes };

let db: Database;

interface StoredRoomModeRow {
  roomMode: RoomMode;
  source: RoomModeSource;
}

export interface AssignRoomInput {
  name: string;
  roomMode?: RoomMode;
  ownerAgentType?: AgentType;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
  workDir?: string;
  addedAt?: string;
  ownerAgentConfig?: RegisteredGroup['agentConfig'];
}
export type {
  MemoryRecord,
  MemoryScopeKind,
  MemorySourceKind,
  RecallMemoryQuery,
} from './db/memories.js';
export type { ChatInfo } from './db/messages.js';
export type { WorkItem } from './db/work-items.js';
export type { ChannelOwnerLeaseRow } from './db/channel-owner-leases.js';
export type { ServiceHandoff } from './db/service-handoffs.js';

function backfillMessageSeq(database: Database): void {
  const rows = database
    .prepare(
      `SELECT rowid, seq
       FROM messages
       ORDER BY CASE WHEN seq IS NULL THEN 1 ELSE 0 END, seq, timestamp, rowid`,
    )
    .all() as Array<{ rowid: number; seq: number | null }>;

  if (rows.length === 0) {
    return;
  }

  let nextSeq = 1;
  const assignSeq = database.prepare(
    'UPDATE messages SET seq = ? WHERE rowid = ? AND seq IS NULL',
  );
  const tx = database.transaction(() => {
    for (const row of rows) {
      if (row.seq === null) {
        assignSeq.run(nextSeq, row.rowid);
      }
      nextSeq = Math.max(nextSeq, (row.seq ?? nextSeq) + 1);
    }
  });
  tx();

  const maxSeqRow = database
    .prepare('SELECT MAX(seq) AS maxSeq FROM messages')
    .get() as { maxSeq: number | null };
  const maxSeq = maxSeqRow.maxSeq ?? 0;
  if (maxSeq > 0) {
    database
      .prepare('INSERT OR IGNORE INTO message_sequence (id) VALUES (?)')
      .run(maxSeq);
  }
}

function getSchemaMigrationHooks(): SchemaMigrationHooks {
  return {
    backfillMessageSeq,
    backfillStoredRoomSettings,
    backfillChannelOwnerRoleMetadata,
    backfillWorkItemServiceShadows,
    backfillServiceHandoffServiceShadows,
    backfillPairedTaskRoleMetadata,
    rebuildWorkItemsCanonicalSchema,
    rebuildChannelOwnerCanonicalSchema,
    rebuildPairedTasksCanonicalSchema,
    rebuildServiceHandoffsCanonicalSchema,
  };
}

export function initDatabase(): void {
  db = openPersistentDatabase();
  initializeDatabaseSchema(db, getSchemaMigrationHooks());
  clearPairedTaskExecutionLeasesForServiceInDatabase(
    db,
    normalizeServiceId(SERVICE_ID),
  );
  clearExpiredPairedTaskExecutionLeasesInDatabase(db);
  migrateJsonStateFromFiles({
    setRouterState,
    setSession,
    writeLegacyRegisteredGroupAndSyncRoomSettings,
  });
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = openInMemoryDatabase();
  initializeDatabaseSchema(db, getSchemaMigrationHooks());
  clearPairedTaskExecutionLeasesForServiceInDatabase(
    db,
    normalizeServiceId(SERVICE_ID),
  );
  clearExpiredPairedTaskExecutionLeasesInDatabase(db);
}

/** @internal - for tests only. Opens an existing database file and runs schema/migrations. */
export function _initTestDatabaseFromFile(dbPath: string): void {
  db = openDatabaseFromFile(dbPath);
  initializeDatabaseSchema(db, getSchemaMigrationHooks());
  clearPairedTaskExecutionLeasesForServiceInDatabase(
    db,
    normalizeServiceId(SERVICE_ID),
  );
  clearExpiredPairedTaskExecutionLeasesInDatabase(db);
}

/** @internal - for tests only. */
export function _setStoredRoomOwnerAgentTypeForTests(
  chatJid: string,
  ownerAgentType: AgentType | null,
): void {
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.prepare(
    `UPDATE room_settings
     SET owner_agent_type = ?,
         updated_at = ?
     WHERE chat_jid = ?`,
  ).run(ownerAgentType, new Date().toISOString(), chatJid);
}

/** @internal - for tests only. */
export function _deleteStoredRoomSettingsForTests(chatJid: string): void {
  if (!db) {
    throw new Error('Database not initialized');
  }
  db.prepare('DELETE FROM room_settings WHERE chat_jid = ?').run(chatJid);
}

/** @internal - for tests only. */
export function _setMemoryTimestampsForTests(
  id: number,
  args: {
    createdAt?: string;
    lastUsedAt?: string | null;
    archivedAt?: string | null;
  },
): void {
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
  touchMemoriesInDatabase(db, ids);
}

export function archiveMemory(id: number): void {
  archiveMemoryInDatabase(db, id);
}

export function expireStaleMemories(args?: {
  scopeKind?: MemoryScopeKind;
  scopeKey?: string;
  now?: string;
}): number {
  return expireStaleMemoriesInDatabase(db, args);
}

export function enforceMemoryBounds(
  scopeKind: MemoryScopeKind,
  scopeKey: string,
): void {
  enforceMemoryBoundsInDatabase(db, scopeKind, scopeKey);
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
  return rememberMemoryInDatabase(db, input);
}

export function recallMemories(query: RecallMemoryQuery): MemoryRecord[] {
  return recallMemoriesFromDatabase(db, query);
}

export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  storeChatMetadataInDatabase(db, chatJid, timestamp, name, channel, isGroup);
}

export function getAllChats(): ChatInfo[] {
  return getAllChatsFromDatabase(db);
}

export function storeMessage(msg: NewMessage): void {
  storeMessageInDatabase(db, msg);
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  return getNewMessagesFromDatabase(db, jids, lastTimestamp, botPrefix, limit);
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  return getMessagesSinceFromDatabase(
    db,
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
  return getLatestMessageSeqAtOrBeforeFromDatabase(db, timestamp, chatJid);
}

export function getNewMessagesBySeq(
  jids: string[],
  lastSeqCursor: string | number,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newSeqCursor: string } {
  return getNewMessagesBySeqFromDatabase(
    db,
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
    db,
    chatJid,
    sinceSeqCursor,
    botPrefix,
    limit,
  );
}

/**
 * Get the N most recent messages for a chat, ordered chronologically.
 * Includes both human and bot messages for full conversation context.
 * Used for conversation context retrieval.
 */
export function getRecentChatMessages(
  chatJid: string,
  limit: number = 20,
): NewMessage[] {
  return getRecentChatMessagesFromDatabase(db, chatJid, limit);
}

export function getLastHumanMessageTimestamp(chatJid: string): string | null {
  return getLastHumanMessageTimestampFromDatabase(db, chatJid);
}

export function getLastHumanMessageSender(chatJid: string): string | null {
  return getLastHumanMessageSenderFromDatabase(db, chatJid);
}

export function getLastHumanMessageContent(chatJid: string): string | null {
  return getLastHumanMessageContentFromDatabase(db, chatJid);
}

export function hasRecentRestartAnnouncement(
  chatJid: string,
  sinceTimestamp: string,
): boolean {
  return hasRecentRestartAnnouncementInDatabase(db, chatJid, sinceTimestamp);
}

export function getOpenWorkItem(
  chatJid: string,
  agentType: AgentType = 'claude-code',
  serviceId: string = SERVICE_SESSION_SCOPE,
): WorkItem | undefined {
  return getOpenWorkItemFromDatabase(db, chatJid, agentType, serviceId);
}

export function getOpenWorkItemForChat(chatJid: string): WorkItem | undefined {
  return getOpenWorkItemForChatFromDatabase(db, chatJid);
}

export function createProducedWorkItem(
  input: CreateProducedWorkItemInput,
): WorkItem {
  return createProducedWorkItemInDatabase(db, input);
}

export function markWorkItemDelivered(
  id: number,
  deliveryMessageId?: string | null,
): void {
  markWorkItemDeliveredInDatabase(db, id, deliveryMessageId);
}

export function markWorkItemDeliveryRetry(id: number, error: string): void {
  markWorkItemDeliveryRetryInDatabase(db, id, error);
}

export function createTask(task: CreateScheduledTaskInput): void {
  createTaskInDatabase(db, task);
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return getTaskByIdFromDatabase(db, id);
}

/**
 * Find an existing active/paused CI watcher for the same channel + provider + metadata.
 * Used to prevent duplicate watchers when both agents register for the same CI run.
 */
export function findDuplicateCiWatcher(
  chatJid: string,
  ciProvider: string,
  ciMetadata: string,
): ScheduledTask | undefined {
  return findDuplicateCiWatcherInDatabase(db, chatJid, ciProvider, ciMetadata);
}

export function getTasksForGroup(
  groupFolder: string,
  agentType?: AgentType,
): ScheduledTask[] {
  return getTasksForGroupFromDatabase(db, groupFolder, agentType);
}

export function getAllTasks(agentType?: AgentType): ScheduledTask[] {
  return getAllTasksFromDatabase(db, agentType);
}

export function updateTask(id: string, updates: ScheduledTaskUpdates): void {
  updateTaskInDatabase(db, id, updates);
}

export function updateTaskStatusTracking(
  id: string,
  updates: ScheduledTaskStatusTrackingUpdates,
): void {
  updateTaskStatusTrackingInDatabase(db, id, updates);
}

export function deleteTask(id: string): void {
  const task = getTaskById(id);
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);

  if (!task) return;

  const runtimeTaskId = getTaskRuntimeTaskId(task);
  if (!runtimeTaskId) return;

  const cleanupTargets = [];
  try {
    cleanupTargets.push(
      resolveTaskRuntimeIpcPathFromGroup(task.group_folder, runtimeTaskId),
      resolveTaskSessionsPathFromGroup(task.group_folder, runtimeTaskId),
      resolveServiceTaskSessionsPathFromGroup(
        task.group_folder,
        CLAUDE_SERVICE_ID,
        runtimeTaskId,
      ),
      resolveServiceTaskSessionsPathFromGroup(
        task.group_folder,
        CODEX_MAIN_SERVICE_ID,
        runtimeTaskId,
      ),
      resolveServiceTaskSessionsPathFromGroup(
        task.group_folder,
        CODEX_REVIEW_SERVICE_ID,
        runtimeTaskId,
      ),
    );
  } catch (err) {
    logger.warn(
      { taskId: id, groupFolder: task.group_folder, err },
      'Failed to resolve task-scoped cleanup paths',
    );
    return;
  }

  for (const cleanupPath of cleanupTargets) {
    try {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { taskId: id, cleanupPath, err },
        'Failed to remove task-scoped runtime artifacts',
      );
    }
  }
}

export function hasActiveCiWatcherForChat(chatJid: string): boolean {
  return hasActiveCiWatcherForChatInDatabase(db, chatJid);
}

export function getDueTasks(): ScheduledTask[] {
  return getDueTasksFromDatabase(db);
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  updateTaskAfterRunInDatabase(db, id, nextRun, lastResult);
}

export function logTaskRun(log: TaskRunLog): void {
  logTaskRunInDatabase(db, log);
}

export function getRecentConsecutiveErrors(
  taskId: string,
  limit: number = 5,
): string[] {
  return getRecentConsecutiveErrorsFromDatabase(db, taskId, limit);
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  return getRouterStateFromDatabase(db, key, SERVICE_ID);
}

export function getRouterStateForService(
  key: string,
  serviceId: string,
): string | undefined {
  return getRouterStateForServiceFromDatabase(db, key, serviceId);
}

export function setRouterState(key: string, value: string): void {
  setRouterStateInDatabase(db, key, value);
}

export function setRouterStateForService(
  key: string,
  value: string,
  serviceId: string,
): void {
  setRouterStateForServiceInDatabase(db, key, value, serviceId);
}

// --- Session accessors ---

export function getSession(
  groupFolder: string,
  agentType: AgentType = 'claude-code',
): string | undefined {
  return getSessionFromDatabase(db, groupFolder, agentType);
}

export function setSession(
  groupFolder: string,
  sessionId: string,
  agentType: AgentType = 'claude-code',
): void {
  setSessionInDatabase(db, groupFolder, agentType, sessionId);
}

export function deleteSession(
  groupFolder: string,
  agentType: AgentType = 'claude-code',
): void {
  deleteSessionFromDatabase(db, groupFolder, agentType);
}

export function deleteAllSessionsForGroup(groupFolder: string): void {
  deleteAllSessionsForGroupFromDatabase(db, groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const currentAgentType =
    inferAgentTypeFromServiceShadow(SERVICE_SESSION_SCOPE) ?? 'claude-code';
  return getAllSessionsForAgentTypeFromDatabase(db, currentAgentType);
}

/**
 * Get session for a specific agent type (cross-provider access).
 * Used for provider switch probe attempts.
 */
export function getSessionForAgentType(
  groupFolder: string,
  agentType: string,
): string | undefined {
  return getSessionFromDatabase(db, groupFolder, agentType);
}

/**
 * Save session for a specific agent type without affecting current service's session.
 * Used when probe succeeds and we want to save to target provider's slot only.
 */
export function setSessionForAgentType(
  groupFolder: string,
  agentType: string,
  sessionId: string,
): void {
  setSessionInDatabase(db, groupFolder, agentType, sessionId);
}

/**
 * Get the agent type of the most recent bot response in a chat.
 * Used to detect provider switches for delta handoff.
 */
export function getLastRespondingAgentType(
  chatJid: string,
): AgentType | undefined {
  return getLastRespondingAgentTypeFromDatabase(db, chatJid);
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
  agentType?: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const requestedAgentType = normalizeStoredAgentType(agentType);
  const stored = getStoredRoomSettingsRowFromDatabase(db, jid);
  if (stored) {
    return buildRegisteredGroupFromStoredSettings(
      db,
      stored,
      requestedAgentType,
    );
  }
  return getLegacyRegisteredGroup(db, jid, agentType);
}

function writeLegacyRegisteredGroupAndSyncRoomSettings(
  jid: string,
  group: RegisteredGroup,
): void {
  const existingStored = getStoredRoomSettingsRowFromDatabase(db, jid);
  const existingRoomMode = getStoredRoomModeRow(jid);
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  const tx = db.transaction(() => {
    const seededAgentType = group.agentType || 'claude-code';
    const agentTypes = new Set<AgentType>(collectRegisteredAgentTypes(db, jid));
    agentTypes.add(seededAgentType);
    const inferredRoomMode = inferRoomModeFromRegisteredAgentTypes([
      ...agentTypes,
    ]);
    const roomMode =
      existingRoomMode?.source === 'explicit'
        ? existingRoomMode.roomMode
        : inferredRoomMode;
    const ownerAgentType =
      existingStored?.modeSource === 'explicit' && existingStored.ownerAgentType
        ? existingStored.ownerAgentType
        : inferOwnerAgentTypeFromRegisteredAgentTypes([...agentTypes]);
    const snapshot: RoomRegistrationSnapshot = {
      name: group.name,
      folder: group.folder,
      triggerPattern:
        existingStored?.modeSource === 'explicit' && existingStored.trigger
          ? existingStored.trigger
          : group.trigger,
      requiresTrigger:
        group.requiresTrigger ?? existingStored?.requiresTrigger ?? true,
      isMain: group.isMain ?? existingStored?.isMain ?? false,
      ownerAgentType,
      workDir: group.workDir ?? existingStored?.workDir ?? null,
    };

    if (existingStored) {
      updateStoredRoomMetadata(db, jid, snapshot);
      if (!existingRoomMode || existingRoomMode.source === 'inferred') {
        upsertStoredRoomMode(jid, roomMode, 'inferred');
      }
    } else {
      insertStoredRoomSettings(db, jid, roomMode, 'inferred', snapshot);
    }

    materializeRegisteredGroupsForRoom(
      db,
      jid,
      snapshot,
      roomMode,
      ownerAgentType,
      seededAgentType === ownerAgentType ? group.agentConfig : undefined,
      group.added_at,
    );
  });
  tx();
}

/**
 * @internal Test/migration helper for seeding legacy capability rows.
 * Runtime code must use assignRoom() so room_settings remains the explicit SSOT.
 */
export function _setRegisteredGroupForTests(
  jid: string,
  group: RegisteredGroup,
): void {
  writeLegacyRegisteredGroupAndSyncRoomSettings(jid, group);
}

export function assignRoom(
  chatJid: string,
  input: AssignRoomInput,
): (RegisteredGroup & { jid: string }) | undefined {
  const existing = getStoredRoomSettingsRowFromDatabase(db, chatJid);
  const roomMode = input.roomMode || existing?.roomMode || 'single';
  const ownerAgentType =
    input.ownerAgentType || existing?.ownerAgentType || OWNER_AGENT_TYPE;
  const folder = resolveAssignedRoomFolder(
    db,
    chatJid,
    input.name,
    input.folder,
  );
  const snapshot: RoomRegistrationSnapshot = {
    name: input.name,
    folder,
    triggerPattern: input.trigger || existing?.trigger || `@${ASSISTANT_NAME}`,
    requiresTrigger: input.requiresTrigger ?? existing?.requiresTrigger ?? true,
    isMain: input.isMain ?? existing?.isMain ?? false,
    ownerAgentType,
    workDir: input.workDir ?? existing?.workDir ?? null,
  };
  const now = new Date().toISOString();

  db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE room_settings
         SET room_mode = ?,
             mode_source = 'explicit',
             name = ?,
             folder = ?,
             trigger_pattern = ?,
             requires_trigger = ?,
             is_main = ?,
             owner_agent_type = ?,
             work_dir = ?,
             updated_at = ?
         WHERE chat_jid = ?`,
      ).run(
        roomMode,
        snapshot.name,
        snapshot.folder,
        snapshot.triggerPattern,
        snapshot.requiresTrigger ? 1 : 0,
        snapshot.isMain ? 1 : 0,
        snapshot.ownerAgentType,
        snapshot.workDir,
        now,
        chatJid,
      );
    } else {
      insertStoredRoomSettings(db, chatJid, roomMode, 'explicit', snapshot);
    }

    materializeRegisteredGroupsForRoom(
      db,
      chatJid,
      snapshot,
      roomMode,
      ownerAgentType,
      input.ownerAgentConfig,
      input.addedAt ?? now,
    );
  })();

  return getRegisteredGroup(chatJid);
}

export function updateRegisteredGroupName(jid: string, name: string): void {
  const plan = buildRoomRegistrationPlanForJid(jid, { name });
  if (!plan) {
    return;
  }
  db.transaction(() => {
    if (plan.hasStoredRoom) {
      updateStoredRoomMetadata(db, jid, plan.snapshot);
    } else {
      insertStoredRoomSettings(
        db,
        jid,
        plan.roomMode,
        'inferred',
        plan.snapshot,
      );
    }
    materializeRegisteredGroupsForRoom(
      db,
      jid,
      plan.snapshot,
      plan.roomMode,
      plan.snapshot.ownerAgentType,
    );
  })();
}

export function getAllRegisteredGroups(
  agentTypeFilter?: string,
): Record<string, RegisteredGroup> {
  const result: Record<string, RegisteredGroup> = {};
  const requestedAgentType = normalizeStoredAgentType(agentTypeFilter);
  const storedRows = getStoredRoomRowsFromDatabase(db);

  for (const stored of storedRows) {
    const group = buildRegisteredGroupFromStoredSettings(
      db,
      stored,
      requestedAgentType,
    );
    if (group) {
      const { jid, ...rest } = group;
      result[jid] = rest;
    }
  }

  for (const legacyRow of getLegacyRegisteredGroupRows(db, agentTypeFilter)) {
    if (result[legacyRow.jid]) continue;
    const group = parseRegisteredGroupRow(legacyRow);
    if (group) {
      const { jid, ...rest } = group;
      result[jid] = rest;
    }
  }

  return result;
}

export function getRegisteredAgentTypesForJid(jid: string): AgentType[] {
  if (!db) return [];
  const stored = getStoredRoomSettingsRowFromDatabase(db, jid);
  if (stored) {
    return resolveStoredRoomCapabilityTypes(db, stored);
  }
  return collectRegisteredAgentTypes(db, jid);
}

/**
 * Internal registration/backfill helper.
 * This infers the stored room mode from current registrations and must not be
 * treated as runtime source-of-truth by callers.
 */
function inferStoredRoomModeForJid(jid: string): RoomMode {
  return inferRoomModeFromRegisteredAgentTypes(
    getRegisteredAgentTypesForJid(jid),
  );
}

export function getStoredRoomSettings(
  chatJid: string,
): StoredRoomSettings | undefined {
  if (!db) return undefined;
  return getStoredRoomSettingsRowFromDatabase(db, chatJid);
}

function getStoredRoomModeRow(chatJid: string): StoredRoomModeRow | undefined {
  const row = getStoredRoomSettings(chatJid);
  return row
    ? {
        roomMode: row.roomMode,
        source: row.modeSource,
      }
    : undefined;
}

function syncStoredRoomRegistrationSnapshotForJid(chatJid: string): void {
  const existingSettings = getStoredRoomSettingsRowFromDatabase(db, chatJid);
  const snapshot = collectRoomRegistrationSnapshot(
    db,
    chatJid,
    existingSettings,
  );
  if (!snapshot) return;

  if (!existingSettings) {
    insertStoredRoomSettings(
      db,
      chatJid,
      inferRoomModeFromRegisteredAgentTypes(
        getRegisteredAgentTypesForJid(chatJid),
      ),
      'inferred',
      snapshot,
    );
    return;
  }

  updateStoredRoomMetadata(db, chatJid, snapshot);
}

function buildRoomRegistrationSnapshotFromStoredRoom(
  stored: StoredRoomSettings,
  overrides?: Partial<Pick<RoomRegistrationSnapshot, 'name'>>,
): RoomRegistrationSnapshot {
  const capabilityTypes = resolveStoredRoomCapabilityTypes(db, stored);
  const ownerAgentType =
    stored.ownerAgentType ||
    (capabilityTypes.length > 0
      ? inferOwnerAgentTypeFromRegisteredAgentTypes(capabilityTypes)
      : OWNER_AGENT_TYPE);
  const name = overrides?.name ?? stored.name ?? stored.chatJid;

  return {
    name,
    folder: resolveAssignedRoomFolder(db, stored.chatJid, name, stored.folder),
    triggerPattern: stored.trigger || `@${ASSISTANT_NAME}`,
    requiresTrigger: stored.requiresTrigger ?? true,
    isMain: stored.isMain ?? false,
    ownerAgentType,
    workDir: stored.workDir ?? null,
  };
}

function buildRoomRegistrationPlanForJid(
  chatJid: string,
  overrides?: Partial<Pick<RoomRegistrationSnapshot, 'name'>>,
):
  | {
      snapshot: RoomRegistrationSnapshot;
      roomMode: RoomMode;
      hasStoredRoom: boolean;
    }
  | undefined {
  const stored = getStoredRoomSettingsRowFromDatabase(db, chatJid);
  if (stored) {
    return {
      snapshot: buildRoomRegistrationSnapshotFromStoredRoom(stored, overrides),
      roomMode: stored.roomMode,
      hasStoredRoom: true,
    };
  }

  const snapshot = collectRoomRegistrationSnapshot(db, chatJid);
  if (!snapshot) return undefined;

  return {
    snapshot: {
      ...snapshot,
      name: overrides?.name ?? snapshot.name,
    },
    roomMode: inferRoomModeFromRegisteredAgentTypes(
      collectRegisteredAgentTypes(db, chatJid),
    ),
    hasStoredRoom: false,
  };
}

function upsertStoredRoomMode(
  chatJid: string,
  roomMode: RoomMode,
  source: RoomModeSource,
): void {
  db.prepare(
    `INSERT INTO room_settings (
      chat_jid,
      room_mode,
      mode_source,
      updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_jid) DO UPDATE SET
      room_mode = excluded.room_mode,
      mode_source = excluded.mode_source,
      updated_at = excluded.updated_at`,
  ).run(chatJid, roomMode, source, new Date().toISOString());
}

function syncInferredRoomModeForJid(chatJid: string): void {
  upsertStoredRoomMode(chatJid, inferStoredRoomModeForJid(chatJid), 'inferred');
}

export function getExplicitRoomMode(chatJid: string): RoomMode | undefined {
  const row = getStoredRoomModeRow(chatJid);
  return row?.source === 'explicit' ? row.roomMode : undefined;
}

export function setExplicitRoomMode(chatJid: string, roomMode: RoomMode): void {
  upsertStoredRoomMode(chatJid, roomMode, 'explicit');
}

export function clearExplicitRoomMode(chatJid: string): void {
  const agentTypes = collectRegisteredAgentTypes(db, chatJid);
  if (agentTypes.length === 0) {
    db.prepare('DELETE FROM room_settings WHERE chat_jid = ?').run(chatJid);
    return;
  }
  upsertStoredRoomMode(
    chatJid,
    inferRoomModeFromRegisteredAgentTypes(agentTypes),
    'inferred',
  );
}

export function getEffectiveRoomMode(chatJid: string): RoomMode {
  return getStoredRoomModeRow(chatJid)?.roomMode ?? 'single';
}

function canRunTribunalFromRegisteredAgentTypes(
  agentTypes: readonly AgentType[],
): boolean {
  const types = new Set(agentTypes);
  if (types.size === 0) return false;
  return REVIEWER_AGENT_TYPE === 'claude-code'
    ? types.has('claude-code')
    : types.has('codex');
}

export function getEffectiveRuntimeRoomMode(chatJid: string): RoomMode {
  const stored = getStoredRoomSettings(chatJid);
  if (stored) {
    return stored.roomMode;
  }

  return inferStoredRoomModeForJid(chatJid) === 'tribunal' &&
    canRunTribunalFromRegisteredAgentTypes(
      getRegisteredAgentTypesForJid(chatJid),
    )
    ? 'tribunal'
    : 'single';
}

// --- Paired task/project/workspace state ---

export function upsertPairedProject(project: PairedProject): void {
  upsertPairedProjectInDatabase(db, project);
}

export function getPairedProject(chatJid: string): PairedProject | undefined {
  return getPairedProjectFromDatabase(db, chatJid);
}

export function createPairedTask(task: PairedTask): void {
  createPairedTaskInDatabase(db, task);
}

export function getPairedTaskById(id: string): PairedTask | undefined {
  return getPairedTaskByIdFromDatabase(db, id);
}

export function getLatestPairedTaskForChat(
  chatJid: string,
): PairedTask | undefined {
  return getLatestPairedTaskForChatFromDatabase(db, chatJid);
}

export function getLatestOpenPairedTaskForChat(
  chatJid: string,
): PairedTask | undefined {
  return getLatestOpenPairedTaskForChatFromDatabase(db, chatJid);
}

export function updatePairedTask(id: string, updates: PairedTaskUpdates): void {
  updatePairedTaskInDatabase(db, id, updates);
}

export function updatePairedTaskIfUnchanged(
  id: string,
  expectedUpdatedAt: string,
  updates: PairedTaskUpdates,
): boolean {
  return updatePairedTaskIfUnchangedInDatabase(
    db,
    id,
    expectedUpdatedAt,
    updates,
  );
}

export function reservePairedTurnReservation(args: {
  chatJid: string;
  taskId: string;
  taskStatus: PairedTask['status'];
  roundTripCount: number;
  taskUpdatedAt: string;
  intentKind: PairedTurnReservationIntentKind;
  runId: string;
}): boolean {
  return reservePairedTurnReservationInDatabase(db, args);
}

export function claimPairedTurnReservation(args: {
  chatJid: string;
  taskId: string;
  taskStatus: PairedTask['status'];
  roundTripCount: number;
  taskUpdatedAt: string;
  intentKind: PairedTurnReservationIntentKind;
  runId: string;
}): boolean {
  return claimPairedTurnReservationInDatabase(db, args);
}

export function releasePairedTaskExecutionLease(args: {
  taskId: string;
  runId: string;
}): void {
  releasePairedTaskExecutionLeaseInDatabase(db, args);
}

export function refreshPairedTaskExecutionLease(args: {
  taskId: string;
  runId: string;
  now?: string;
}): boolean {
  return refreshPairedTaskExecutionLeaseInDatabase(db, args);
}

export function upsertPairedWorkspace(workspace: PairedWorkspace): void {
  upsertPairedWorkspaceInDatabase(db, workspace);
}

export function getPairedWorkspace(
  taskId: string,
  role: PairedWorkspace['role'],
): PairedWorkspace | undefined {
  return getPairedWorkspaceFromDatabase(db, taskId, role);
}

export function listPairedWorkspacesForTask(taskId: string): PairedWorkspace[] {
  return listPairedWorkspacesForTaskFromDatabase(db, taskId);
}

/** @internal - for tests only. */
export function _clearPairedTurnReservationsForTests(): void {
  if (!db) {
    throw new Error('Database not initialized');
  }
  clearPairedTurnReservationsInDatabase(db);
  clearPairedTaskExecutionLeasesInDatabase(db);
}

/**
 * Get the most recent bot message (is_bot_message=1) in a chat, regardless of which bot sent it.
 * Used for duplicate detection in pair rooms.
 */
export function getLastBotFinalMessage(
  chatJid: string,
  agentType: AgentType = 'claude-code',
  limit: number = 1,
): Array<{ content: string; timestamp: string }> {
  return getLastBotFinalMessageFromDatabase(db, chatJid, agentType, limit);
}

// --- Channel owner lease accessors ---

export function getChannelOwnerLease(
  chatJid: string,
): ChannelOwnerLeaseRow | undefined {
  return getChannelOwnerLeaseFromDatabase(db, chatJid);
}

export function getAllChannelOwnerLeases(): ChannelOwnerLeaseRow[] {
  return getAllChannelOwnerLeasesFromDatabase(db);
}

export function setChannelOwnerLease(input: SetChannelOwnerLeaseInput): void {
  setChannelOwnerLeaseInDatabase(db, input);
}

export function clearChannelOwnerLease(chatJid: string): void {
  clearChannelOwnerLeaseInDatabase(db, chatJid);
}

// --- Cross-service handoff accessors ---

export function createServiceHandoff(
  input: CreateServiceHandoffInput,
): ServiceHandoff {
  return createServiceHandoffInDatabase(db, input);
}

export function getPendingServiceHandoffs(
  targetServiceId: string = SERVICE_SESSION_SCOPE,
): ServiceHandoff[] {
  return getPendingServiceHandoffsFromDatabase(db, targetServiceId);
}

export function getAllPendingServiceHandoffs(): ServiceHandoff[] {
  return getAllPendingServiceHandoffsFromDatabase(db);
}

export function claimServiceHandoff(id: number): boolean {
  return claimServiceHandoffInDatabase(db, id);
}

export function completeServiceHandoff(id: number): void {
  completeServiceHandoffInDatabase(db, id);
}

export function failServiceHandoff(id: number, error: string): void {
  failServiceHandoffInDatabase(db, id, error);
}

export function completeServiceHandoffAndAdvanceTargetCursor(
  input: CompleteServiceHandoffCursorInput,
): string | null {
  return completeServiceHandoffAndAdvanceTargetCursorInDatabase(db, input);
}

export function insertPairedTurnOutput(
  taskId: string,
  turnNumber: number,
  role: PairedRoomRole,
  outputText: string,
): void {
  insertPairedTurnOutputInDatabase(db, taskId, turnNumber, role, outputText);
}

export function getPairedTurnOutputs(taskId: string): PairedTurnOutput[] {
  return getPairedTurnOutputsFromDatabase(db, taskId);
}

export function getLatestTurnNumber(taskId: string): number {
  return getLatestTurnNumberFromDatabase(db, taskId);
}
