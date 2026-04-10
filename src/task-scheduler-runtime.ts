import fs from 'fs';

import { writeTasksSnapshot } from './agent-runner.js';
import { getAllTasks } from './db.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  resolveTaskRuntimeIpcPath,
} from './group-folder.js';
import { logger } from './logger.js';
import { hasReviewerLease } from './service-routing.js';
import {
  getTaskQueueJid,
  getTaskRuntimeTaskId,
  shouldUseTaskScopedSession,
} from './task-watch-status.js';
import type { AgentType, ScheduledTask } from './types.js';
import type {
  SchedulerDependencies,
  TaskExecutionContext,
} from './task-scheduler-types.js';

export function hasTaskExceededMaxDuration(
  task: Pick<ScheduledTask, 'id' | 'created_at' | 'max_duration_ms'>,
  nowMs: number,
): boolean {
  if (
    task.max_duration_ms === null ||
    task.max_duration_ms === undefined ||
    !Number.isFinite(task.max_duration_ms) ||
    task.max_duration_ms <= 0
  ) {
    return false;
  }

  const createdAtMs = new Date(task.created_at).getTime();
  if (!Number.isFinite(createdAtMs)) {
    logger.warn(
      { taskId: task.id, createdAt: task.created_at },
      'Task has invalid created_at for max duration enforcement',
    );
    return false;
  }

  return nowMs - createdAtMs >= task.max_duration_ms;
}

export async function sendScheduledMessage(
  deps: SchedulerDependencies,
  chatJid: string,
  text: string,
): Promise<void> {
  if (!hasReviewerLease(chatJid)) {
    await deps.sendMessage(chatJid, text);
    return;
  }

  if (!deps.sendMessageViaReviewerBot) {
    throw new Error(
      'Paired-room scheduled output requires a configured reviewer Discord bot',
    );
  }

  await deps.sendMessageViaReviewerBot(chatJid, text);
}

export function resolveTaskExecutionContext(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): TaskExecutionContext {
  const groupDir = resolveGroupFolderPath(task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const groups = deps.roomBindings();
  const group = Object.values(groups).find(
    (registeredGroup) => registeredGroup.folder === task.group_folder,
  );
  if (!group) {
    throw new Error(`Group not found: ${task.group_folder}`);
  }

  const isMain = group.isMain === true;
  const taskAgentType =
    task.agent_type || deps.serviceAgentType || 'claude-code';
  const sessions = deps.getSessions();
  const runtimeTaskId = getTaskRuntimeTaskId(task);
  const useTaskScopedSession = shouldUseTaskScopedSession(task);
  const runtimeIpcDir = runtimeTaskId
    ? resolveTaskRuntimeIpcPath(task.group_folder, runtimeTaskId)
    : resolveGroupIpcPath(task.group_folder);

  return {
    group,
    groupDir,
    isMain,
    queueJid: getTaskQueueJid(task),
    runtimeIpcDir,
    runtimeTaskId,
    sessionId:
      task.context_mode === 'group' ? sessions[task.group_folder] : undefined,
    useTaskScopedSession,
    taskAgentType,
  };
}

export function writeTaskSnapshotForGroup(
  taskAgentType: AgentType,
  groupFolder: string,
  isMain: boolean,
  runtimeTaskId?: string,
): void {
  const tasks = getAllTasks(taskAgentType);
  writeTasksSnapshot(
    groupFolder,
    isMain,
    tasks.map((task) => ({
      id: task.id,
      groupFolder: task.group_folder,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    })),
    runtimeTaskId,
  );
}
