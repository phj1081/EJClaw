import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import {
  ARBITER_AGENT_TYPE,
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  SERVICE_ID,
  SERVICE_SESSION_SCOPE,
} from './config.js';
import {
  resolveTaskRuntimeIpcPath as resolveTaskRuntimeIpcPathFromGroup,
  resolveServiceTaskSessionsPath as resolveServiceTaskSessionsPathFromGroup,
  resolveTaskSessionsPath as resolveTaskSessionsPathFromGroup,
} from './group-folder.js';
import { logger } from './logger.js';
import {
  type StoredRoomSettings,
  inferRoomModeFromRegisteredAgentTypes,
} from './db/room-registration.js';
import {
  openInitializedDatabaseFromFile,
  openInitializedInMemoryDatabase,
  openInitializedPersistentDatabase,
} from './db/database-lifecycle.js';
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
  clearPairedTurnAttemptsInDatabase,
  getPairedTurnAttemptsForTurnFromDatabase,
  type PairedTurnAttemptRecord,
} from './db/paired-turn-attempts.js';
import {
  clearPairedTurnsInDatabase,
  completePairedTurnInDatabase,
  failPairedTurnInDatabase,
  getPairedTurnByIdFromDatabase,
  getPairedTurnsForTaskFromDatabase,
  markPairedTurnRunningInDatabase,
  type PairedTurnRecord,
} from './db/paired-turns.js';
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
  type AssignRoomInput,
  assignRoomInDatabase,
  clearExplicitRoomModeInDatabase,
  deleteStoredRoomSettingsForTestsInDatabase,
  getAllRoomBindingsFromDatabase,
  getEffectiveRoomModeFromDatabase,
  getEffectiveRuntimeRoomModeFromDatabase,
  getExplicitRoomModeFromDatabase,
  getRegisteredAgentTypesForJidFromDatabase,
  getRegisteredGroupFromDatabase,
  getStoredRoomSettingsFromDatabase,
  setExplicitRoomModeInDatabase,
  setRegisteredGroupForTestsInDatabase,
  setStoredRoomOwnerAgentTypeForTestsInDatabase,
  updateRegisteredGroupNameInDatabase,
} from './db/rooms.js';
import {
  deleteAllSessionsForGroupFromDatabase,
  deleteSessionFromDatabase,
  getAllSessionsForAgentTypeFromDatabase,
  getSessionFromDatabase,
  setSessionInDatabase,
} from './db/sessions.js';
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
import { inferAgentTypeFromServiceShadow } from './role-service-shadow.js';
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
export type { AssignRoomInput } from './db/rooms.js';
export type {
  MemoryRecord,
  MemoryScopeKind,
  MemorySourceKind,
  RecallMemoryQuery,
} from './db/memories.js';
export type { PairedTurnAttemptRecord } from './db/paired-turn-attempts.js';
export type { PairedTurnRecord } from './db/paired-turns.js';
export type { ChatInfo } from './db/messages.js';
export type { WorkItem } from './db/work-items.js';
export type { ChannelOwnerLeaseRow } from './db/channel-owner-leases.js';
export type { ServiceHandoff } from './db/service-handoffs.js';

export function initDatabase(): void {
  db = openInitializedPersistentDatabase();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = openInitializedInMemoryDatabase();
}

/** @internal - for tests only. Opens an existing database file and runs schema/migrations. */
export function _initTestDatabaseFromFile(dbPath: string): void {
  db = openInitializedDatabaseFromFile(dbPath);
}

/** @internal - for tests only. */
export function _setStoredRoomOwnerAgentTypeForTests(
  chatJid: string,
  ownerAgentType: AgentType | null,
): void {
  if (!db) {
    throw new Error('Database not initialized');
  }
  setStoredRoomOwnerAgentTypeForTestsInDatabase(db, chatJid, ownerAgentType);
}

/** @internal - for tests only. */
export function _deleteStoredRoomSettingsForTests(chatJid: string): void {
  if (!db) {
    throw new Error('Database not initialized');
  }
  deleteStoredRoomSettingsForTestsInDatabase(db, chatJid);
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

export function getOpenWorkItemForChat(
  chatJid: string,
  serviceId: string = SERVICE_SESSION_SCOPE,
): WorkItem | undefined {
  return getOpenWorkItemForChatFromDatabase(db, chatJid, serviceId);
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
  return getRegisteredGroupFromDatabase(db, jid, agentType);
}

/** @internal Test helper for seeding canonical room bindings. */
export function _setRegisteredGroupForTests(
  jid: string,
  group: RegisteredGroup,
): void {
  setRegisteredGroupForTestsInDatabase(db, jid, group);
}

export function assignRoom(
  chatJid: string,
  input: AssignRoomInput,
): (RegisteredGroup & { jid: string }) | undefined {
  return assignRoomInDatabase(db, chatJid, input);
}

export function updateRegisteredGroupName(jid: string, name: string): void {
  updateRegisteredGroupNameInDatabase(db, jid, name);
}

export function getAllRoomBindings(
  agentTypeFilter?: string,
): Record<string, RegisteredGroup> {
  return getAllRoomBindingsFromDatabase(db, agentTypeFilter);
}

export function getRegisteredAgentTypesForJid(jid: string): AgentType[] {
  if (!db) return [];
  return getRegisteredAgentTypesForJidFromDatabase(db, jid);
}

export function getStoredRoomSettings(
  chatJid: string,
): StoredRoomSettings | undefined {
  if (!db) return undefined;
  return getStoredRoomSettingsFromDatabase(db, chatJid);
}

export function getExplicitRoomMode(chatJid: string): RoomMode | undefined {
  return getExplicitRoomModeFromDatabase(db, chatJid);
}

export function setExplicitRoomMode(chatJid: string, roomMode: RoomMode): void {
  setExplicitRoomModeInDatabase(db, chatJid, roomMode);
}

export function clearExplicitRoomMode(chatJid: string): void {
  clearExplicitRoomModeInDatabase(db, chatJid);
}

export function getEffectiveRoomMode(chatJid: string): RoomMode {
  return getEffectiveRoomModeFromDatabase(db, chatJid);
}

export function getEffectiveRuntimeRoomMode(chatJid: string): RoomMode {
  return getEffectiveRuntimeRoomModeFromDatabase(db, chatJid);
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

export function markPairedTurnRunning(args: {
  turnIdentity: import('./paired-turn-identity.js').PairedTurnIdentity;
  executorServiceId?: string | null;
  executorAgentType?: AgentType | null;
  runId?: string | null;
}): void {
  markPairedTurnRunningInDatabase(db, args);
}

export function completePairedTurn(
  turnIdentity: import('./paired-turn-identity.js').PairedTurnIdentity,
): void {
  completePairedTurnInDatabase(db, turnIdentity);
}

export function failPairedTurn(args: {
  turnIdentity: import('./paired-turn-identity.js').PairedTurnIdentity;
  error?: string | null;
}): void {
  failPairedTurnInDatabase(db, args);
}

export function getPairedTurnById(
  turnId: string,
): PairedTurnRecord | undefined {
  return getPairedTurnByIdFromDatabase(db, turnId);
}

export function getPairedTurnsForTask(taskId: string): PairedTurnRecord[] {
  return getPairedTurnsForTaskFromDatabase(db, taskId);
}

export function getPairedTurnAttempts(
  turnId: string,
): PairedTurnAttemptRecord[] {
  return getPairedTurnAttemptsForTurnFromDatabase(db, turnId);
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
  clearPairedTurnAttemptsInDatabase(db);
  clearPairedTurnsInDatabase(db);
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
