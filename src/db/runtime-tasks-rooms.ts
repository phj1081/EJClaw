import fs from 'fs';

import {
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  SERVICE_ID,
  SERVICE_SESSION_SCOPE,
} from '../config.js';
import {
  resolveServiceTaskSessionsPath as resolveServiceTaskSessionsPathFromGroup,
  resolveTaskRuntimeIpcPath as resolveTaskRuntimeIpcPathFromGroup,
  resolveTaskSessionsPath as resolveTaskSessionsPathFromGroup,
} from '../group-folder.js';
import { logger } from '../logger.js';
import { inferAgentTypeFromServiceShadow } from '../role-service-shadow.js';
import { getTaskRuntimeTaskId } from '../task-watch-status.js';
import {
  AgentType,
  RegisteredGroup,
  RoomMode,
  ScheduledTask,
  TaskRunLog,
} from '../types.js';

import {
  type AssignRoomInput,
  assignRoomInDatabase,
  clearExplicitRoomModeInDatabase,
  deleteStoredRoomSettingsForTestsInDatabase,
  deleteStoredRoomSkillOverrideFromDatabase,
  getAllRoomBindingsFromDatabase,
  getEffectiveRoomModeFromDatabase,
  getEffectiveRuntimeRoomModeFromDatabase,
  getExplicitRoomModeFromDatabase,
  getRegisteredAgentTypesForJidFromDatabase,
  getRegisteredGroupFromDatabase,
  getStoredRoomRoleAgentPlanFromDatabase,
  getStoredRoomSettingsFromDatabase,
  getStoredRoomSkillOverridesFromDatabase,
  setExplicitRoomModeInDatabase,
  setRegisteredGroupForTestsInDatabase,
  setStoredRoomOwnerAgentTypeForTestsInDatabase,
  type StoredRoomSkillOverride,
  type StoredRoomSkillOverrideInput,
  updateRegisteredGroupNameInDatabase,
  upsertStoredRoomSkillOverrideInDatabase,
} from './rooms.js';
import { type StoredRoomSettings } from './room-registration.js';
import {
  deleteAllSessionsForGroupFromDatabase,
  deleteSessionFromDatabase,
  getAllSessionsForAgentTypeFromDatabase,
  getSessionFromDatabase,
  setSessionInDatabase,
} from './sessions.js';
import {
  getLastRespondingAgentTypeFromDatabase,
  getRouterStateForServiceFromDatabase,
  getRouterStateFromDatabase,
  setRouterStateForServiceInDatabase,
  setRouterStateInDatabase,
} from './router-state.js';
import {
  getDatabaseIfInitialized,
  requireDatabase,
} from './runtime-database.js';
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
} from './tasks.js';

/** @internal - for tests only. */
export function _setStoredRoomOwnerAgentTypeForTests(
  chatJid: string,
  ownerAgentType: AgentType | null,
): void {
  setStoredRoomOwnerAgentTypeForTestsInDatabase(
    requireDatabase(),
    chatJid,
    ownerAgentType,
  );
}

/** @internal - for tests only. */
export function _deleteStoredRoomSettingsForTests(chatJid: string): void {
  deleteStoredRoomSettingsForTestsInDatabase(requireDatabase(), chatJid);
}

export function createTask(task: CreateScheduledTaskInput): void {
  createTaskInDatabase(requireDatabase(), task);
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return getTaskByIdFromDatabase(requireDatabase(), id);
}

export function findDuplicateCiWatcher(
  chatJid: string,
  ciProvider: string,
  ciMetadata: string,
): ScheduledTask | undefined {
  return findDuplicateCiWatcherInDatabase(
    requireDatabase(),
    chatJid,
    ciProvider,
    ciMetadata,
  );
}

export function getTasksForGroup(
  groupFolder: string,
  agentType?: AgentType,
): ScheduledTask[] {
  return getTasksForGroupFromDatabase(
    requireDatabase(),
    groupFolder,
    agentType,
  );
}

export function getAllTasks(agentType?: AgentType): ScheduledTask[] {
  return getAllTasksFromDatabase(requireDatabase(), agentType);
}

export function updateTask(id: string, updates: ScheduledTaskUpdates): void {
  updateTaskInDatabase(requireDatabase(), id, updates);
}

export function updateTaskStatusTracking(
  id: string,
  updates: ScheduledTaskStatusTrackingUpdates,
): void {
  updateTaskStatusTrackingInDatabase(requireDatabase(), id, updates);
}

export function deleteTask(id: string): void {
  const db = requireDatabase();
  const task = getTaskByIdFromDatabase(db, id);

  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);

  if (!task) return;

  const runtimeTaskId = getTaskRuntimeTaskId(task);
  if (!runtimeTaskId) return;

  const cleanupTargets: string[] = [];
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
  return hasActiveCiWatcherForChatInDatabase(requireDatabase(), chatJid);
}

export function getDueTasks(): ScheduledTask[] {
  return getDueTasksFromDatabase(requireDatabase());
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  updateTaskAfterRunInDatabase(requireDatabase(), id, nextRun, lastResult);
}

export function logTaskRun(log: TaskRunLog): void {
  logTaskRunInDatabase(requireDatabase(), log);
}

export function getRecentConsecutiveErrors(
  taskId: string,
  limit: number = 5,
): string[] {
  return getRecentConsecutiveErrorsFromDatabase(
    requireDatabase(),
    taskId,
    limit,
  );
}

export function getRouterState(key: string): string | undefined {
  return getRouterStateFromDatabase(requireDatabase(), key, SERVICE_ID);
}

export function getRouterStateForService(
  key: string,
  serviceId: string,
): string | undefined {
  return getRouterStateForServiceFromDatabase(
    requireDatabase(),
    key,
    serviceId,
  );
}

export function setRouterState(key: string, value: string): void {
  setRouterStateInDatabase(requireDatabase(), key, value);
}

export function setRouterStateForService(
  key: string,
  value: string,
  serviceId: string,
): void {
  setRouterStateForServiceInDatabase(requireDatabase(), key, value, serviceId);
}

export function getSession(
  groupFolder: string,
  agentType: AgentType = 'claude-code',
): string | undefined {
  return getSessionFromDatabase(requireDatabase(), groupFolder, agentType);
}

export function setSession(
  groupFolder: string,
  sessionId: string,
  agentType: AgentType = 'claude-code',
): void {
  setSessionInDatabase(requireDatabase(), groupFolder, agentType, sessionId);
}

export function deleteSession(
  groupFolder: string,
  agentType: AgentType = 'claude-code',
): void {
  deleteSessionFromDatabase(requireDatabase(), groupFolder, agentType);
}

export function deleteAllSessionsForGroup(groupFolder: string): void {
  deleteAllSessionsForGroupFromDatabase(requireDatabase(), groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const currentAgentType =
    inferAgentTypeFromServiceShadow(SERVICE_SESSION_SCOPE) ?? 'claude-code';
  return getAllSessionsForAgentTypeFromDatabase(
    requireDatabase(),
    currentAgentType,
  );
}

export function getSessionForAgentType(
  groupFolder: string,
  agentType: string,
): string | undefined {
  return getSessionFromDatabase(requireDatabase(), groupFolder, agentType);
}

export function setSessionForAgentType(
  groupFolder: string,
  agentType: string,
  sessionId: string,
): void {
  setSessionInDatabase(requireDatabase(), groupFolder, agentType, sessionId);
}

export function getLastRespondingAgentType(
  chatJid: string,
): AgentType | undefined {
  return getLastRespondingAgentTypeFromDatabase(requireDatabase(), chatJid);
}

export function getRegisteredGroup(
  jid: string,
  agentType?: string,
): (RegisteredGroup & { jid: string }) | undefined {
  return getRegisteredGroupFromDatabase(requireDatabase(), jid, agentType);
}

/** @internal Test helper for seeding canonical room bindings. */
export function _setRegisteredGroupForTests(
  jid: string,
  group: RegisteredGroup,
): void {
  setRegisteredGroupForTestsInDatabase(requireDatabase(), jid, group);
}

export function assignRoom(
  chatJid: string,
  input: AssignRoomInput,
): (RegisteredGroup & { jid: string }) | undefined {
  return assignRoomInDatabase(requireDatabase(), chatJid, input);
}

export function updateRegisteredGroupName(jid: string, name: string): void {
  updateRegisteredGroupNameInDatabase(requireDatabase(), jid, name);
}

export function getAllRoomBindings(
  agentTypeFilter?: string,
): Record<string, RegisteredGroup> {
  return getAllRoomBindingsFromDatabase(requireDatabase(), agentTypeFilter);
}

export function getRegisteredAgentTypesForJid(jid: string): AgentType[] {
  const db = getDatabaseIfInitialized();
  if (!db) return [];
  return getRegisteredAgentTypesForJidFromDatabase(db, jid);
}

export function getStoredRoomSettings(
  chatJid: string,
): StoredRoomSettings | undefined {
  const db = getDatabaseIfInitialized();
  if (!db) return undefined;
  return getStoredRoomSettingsFromDatabase(db, chatJid);
}

export function getStoredRoomRoleAgentPlan(
  chatJid: string,
): ReturnType<typeof getStoredRoomRoleAgentPlanFromDatabase> {
  const db = getDatabaseIfInitialized();
  if (!db) return undefined;
  return getStoredRoomRoleAgentPlanFromDatabase(db, chatJid);
}

export function getStoredRoomSkillOverrides(
  chatJid?: string,
): StoredRoomSkillOverride[] {
  const db = getDatabaseIfInitialized();
  if (!db) return [];
  return getStoredRoomSkillOverridesFromDatabase(db, chatJid);
}

export function upsertStoredRoomSkillOverride(
  input: StoredRoomSkillOverrideInput,
): void {
  upsertStoredRoomSkillOverrideInDatabase(requireDatabase(), input);
}

export function deleteStoredRoomSkillOverride(
  input: Omit<StoredRoomSkillOverrideInput, 'enabled'>,
): void {
  deleteStoredRoomSkillOverrideFromDatabase(requireDatabase(), input);
}

export function getExplicitRoomMode(chatJid: string): RoomMode | undefined {
  return getExplicitRoomModeFromDatabase(requireDatabase(), chatJid);
}

export function setExplicitRoomMode(chatJid: string, roomMode: RoomMode): void {
  setExplicitRoomModeInDatabase(requireDatabase(), chatJid, roomMode);
}

export function clearExplicitRoomMode(chatJid: string): void {
  clearExplicitRoomModeInDatabase(requireDatabase(), chatJid);
}

export function getEffectiveRoomMode(chatJid: string): RoomMode {
  return getEffectiveRoomModeFromDatabase(requireDatabase(), chatJid);
}

export function getEffectiveRuntimeRoomMode(chatJid: string): RoomMode {
  return getEffectiveRuntimeRoomModeFromDatabase(requireDatabase(), chatJid);
}
