import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  ASSISTANT_NAME,
  SCHEDULER_POLL_INTERVAL,
  SERVICE_AGENT_TYPE,
  TIMEZONE,
} from './config.js';
import {
  AgentOutput,
  runAgentProcess,
  writeTasksSnapshot,
} from './agent-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  resolveTaskRuntimeIpcPath,
} from './group-folder.js';
import { logger } from './logger.js';
import { createTaskStatusTracker } from './task-status-tracker.js';
import { detectFallbackTrigger } from './provider-fallback.js';
import {
  rotateCodexToken,
  getCodexAccountCount,
  markCodexTokenHealthy,
} from './codex-token-rotation.js';
import {
  rotateToken,
  getTokenCount,
  markTokenHealthy,
} from './token-rotation.js';
import {
  evaluateTaskSuspension,
  formatSuspensionNotice,
  suspendTask,
} from './task-suspension.js';
import {
  getTaskQueueJid,
  getTaskRuntimeTaskId,
  shouldUseTaskScopedSession,
} from './task-watch-status.js';
import { AgentType, RegisteredGroup, ScheduledTask } from './types.js';
export {
  extractWatchCiTarget,
  getTaskQueueJid,
  getTaskRuntimeTaskId,
  isTaskStatusControlMessage,
  isWatchCiTask,
  renderWatchCiStatusMessage,
  shouldUseTaskScopedSession,
} from './task-watch-status.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  serviceAgentType?: AgentType;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    processName: string,
    ipcDir: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendTrackedMessage?: (jid: string, text: string) => Promise<string | null>;
  editTrackedMessage?: (
    jid: string,
    messageId: string,
    text: string,
  ) => Promise<void>;
}

interface TaskExecutionContext {
  group: RegisteredGroup;
  groupDir: string;
  isMain: boolean;
  queueJid: string;
  runtimeIpcDir: string;
  runtimeTaskId?: string;
  sessionId?: string;
  useTaskScopedSession: boolean;
  taskAgentType: AgentType;
}

function resolveTaskExecutionContext(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): TaskExecutionContext {
  const groupDir = resolveGroupFolderPath(task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (registeredGroup) => registeredGroup.folder === task.group_folder,
  );
  if (!group) {
    throw new Error(`Group not found: ${task.group_folder}`);
  }

  const isMain = group.isMain === true;
  const taskAgentType =
    task.agent_type || deps.serviceAgentType || SERVICE_AGENT_TYPE;
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

function writeTaskSnapshotForGroup(
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

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let context: TaskExecutionContext;
  try {
    context = resolveTaskExecutionContext(task, deps);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (error.startsWith('Group not found:')) {
      logger.error(
        { taskId: task.id, groupFolder: task.group_folder, error },
        'Group not found for task',
      );
    } else {
      // Stop retry churn for malformed legacy rows.
      updateTask(task.id, { status: 'paused' });
      logger.error(
        { taskId: task.id, groupFolder: task.group_folder, error },
        'Task has invalid group folder',
      );
    }
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  // Update tasks snapshot for agent to read (filtered by group)
  writeTaskSnapshotForGroup(
    context.taskAgentType,
    task.group_folder,
    context.isMain,
    context.runtimeTaskId,
  );

  let result: string | null = null;
  let error: string | null = null;
  const statusTracker = createTaskStatusTracker(task, {
    sendTrackedMessage: deps.sendTrackedMessage,
    editTrackedMessage: deps.editTrackedMessage,
  });

  try {
    await statusTracker.update('checking');

    const output = await runAgentProcess(
      context.group,
      {
        prompt: task.prompt,
        sessionId: context.sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain: context.isMain,
        isScheduledTask: true,
        runtimeTaskId: context.runtimeTaskId,
        useTaskScopedSession: context.useTaskScopedSession,
        assistantName: ASSISTANT_NAME,
      },
      (proc, processName) =>
        deps.onProcess(
          context.queueJid,
          proc,
          processName,
          context.runtimeIpcDir,
        ),
      async (streamedOutput: AgentOutput) => {
        if (streamedOutput.phase === 'progress') {
          return;
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      {
        taskId: task.id,
        agentType: context.taskAgentType,
        durationMs: Date.now() - startTime,
      },
      'Task completed',
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;
  const currentTask = getTaskById(task.id);
  const nextRun = currentTask ? computeNextRun(task) : null;

  if (!currentTask) {
    await statusTracker.update('completed');
    logger.debug(
      { taskId: task.id },
      'Task deleted during execution, skipping persistence',
    );
    return;
  }

  // Clear suspension on success
  if (!error && currentTask.suspended_until) {
    updateTask(task.id, { suspended_until: null });
  }

  // Try token rotation before suspending
  if (error) {
    const trigger = detectFallbackTrigger(error);
    if (trigger.shouldFallback) {
      const isCodex = SERVICE_AGENT_TYPE === 'codex';
      const rotated = isCodex
        ? getCodexAccountCount() > 1 && rotateCodexToken()
        : getTokenCount() > 1 && rotateToken();
      if (rotated) {
        logger.info(
          { taskId: task.id, agent: SERVICE_AGENT_TYPE, reason: trigger.reason },
          'Task rate-limited, rotated token — will retry on next schedule',
        );
        if (isCodex) markCodexTokenHealthy();
        else markTokenHealthy();
        // Clear the error so suspension doesn't trigger
        error = null;
      }
    }
  }

  // Check for repeated quota/auth errors → auto-suspend
  let suspended = false;
  if (error) {
    const suspension = evaluateTaskSuspension(currentTask, error);
    if (suspension.suspended && suspension.suspendedUntil) {
      suspended = true;
      suspendTask(task.id, suspension.suspendedUntil);
      const notice = formatSuspensionNotice(
        currentTask,
        suspension.suspendedUntil,
        suspension.reason || error.slice(0, 200),
      );
      await deps.sendMessage(task.chat_jid, notice);
    }
  }

  if (error && !suspended) {
    await statusTracker.update('retrying', nextRun);
  } else if (suspended) {
    // Don't update status tracker — task is suspended, not retrying
  } else if (nextRun) {
    await statusTracker.update('waiting', nextRun);
  } else {
    await statusTracker.update('completed');
  }

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let schedulerLoopFn: (() => Promise<void>) | null = null;
let schedulerTickInFlight = false;
let schedulerTickPending = false;

function scheduleSchedulerTick(delayMs: number): void {
  if (!schedulerRunning || !schedulerLoopFn) return;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
  }
  schedulerTimer = setTimeout(() => {
    schedulerTimer = null;
    void schedulerLoopFn?.();
  }, delayMs);
}

export function nudgeSchedulerLoop(): void {
  if (!schedulerRunning || !schedulerLoopFn) return;
  if (schedulerTickInFlight) {
    schedulerTickPending = true;
    return;
  }
  scheduleSchedulerTick(0);
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    if (schedulerTickInFlight) {
      schedulerTickPending = true;
      return;
    }
    schedulerTickInFlight = true;

    try {
      const dueTasks = getDueTasks(deps.serviceAgentType || SERVICE_AGENT_TYPE);
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(
          getTaskQueueJid(currentTask),
          currentTask.id,
          () => runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    } finally {
      schedulerTickInFlight = false;
    }

    if (!schedulerRunning) {
      return;
    }

    if (schedulerTickPending) {
      schedulerTickPending = false;
      scheduleSchedulerTick(0);
      return;
    }

    scheduleSchedulerTick(SCHEDULER_POLL_INTERVAL);
  };

  schedulerLoopFn = loop;
  void loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
  schedulerLoopFn = null;
  schedulerTickInFlight = false;
  schedulerTickPending = false;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}
