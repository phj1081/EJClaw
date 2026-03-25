import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';
import { getErrorMessage } from './utils.js';

import {
  ASSISTANT_NAME,
  DATA_DIR,
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
  deleteTask,
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
import {
  detectFallbackTrigger,
  getActiveProvider,
  getFallbackEnvOverrides,
  getFallbackProviderName,
  hasGroupProviderOverride,
  isFallbackEnabled,
  isPrimaryNoFallbackCooldownActive,
  markPrimaryCooldown,
} from './provider-fallback.js';
import { runClaudeRotationLoop } from './provider-retry.js';
import {
  detectCodexRotationTrigger,
  rotateCodexToken,
  getCodexAccountCount,
  markCodexTokenHealthy,
} from './codex-token-rotation.js';
import type {
  AgentTriggerReason,
  CodexRotationReason,
} from './agent-error-detection.js';
import {
  getTokenCount,
  markTokenHealthy,
  rotateToken,
} from './token-rotation.js';
import {
  evaluateTaskSuspension,
  formatSuspensionNotice,
  suspendTask,
} from './task-suspension.js';
import {
  evaluateStreamedOutput,
  type StreamedOutputState,
} from './streamed-output-evaluator.js';
import {
  getTaskQueueJid,
  getTaskRuntimeTaskId,
  isGitHubCiTask,
  shouldUseTaskScopedSession,
} from './task-watch-status.js';
import { AgentType, RegisteredGroup, ScheduledTask } from './types.js';
import { checkGitHubActionsRun } from './github-ci.js';
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

function hasTaskExceededMaxDuration(
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
    const error = getErrorMessage(err);
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
  const settingsPath = path.join(
    DATA_DIR,
    'sessions',
    task.group_folder,
    '.claude',
    'settings.json',
  );
  const isClaudeAgent = context.taskAgentType === 'claude-code';
  const canRotateToken = isClaudeAgent && getTokenCount() > 1;
  const canFallback =
    isClaudeAgent &&
    isFallbackEnabled() &&
    !hasGroupProviderOverride(settingsPath);

  try {
    await statusTracker.update('checking');

    const runTaskAttempt = async (
      provider: string,
    ): Promise<{
      output: AgentOutput;
      sawOutput: boolean;
      streamedTriggerReason?: {
        reason: AgentTriggerReason;
        retryAfterMs?: number;
      };
      attemptResult: string | null;
      attemptError: string | null;
    }> => {
      let streamedState: StreamedOutputState = {
        sawOutput: false,
        sawSuccessNullResultWithoutOutput: false,
      };
      let attemptResult: string | null = null;
      let attemptError: string | null = null;

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
          const evaluation = evaluateStreamedOutput(
            streamedOutput,
            streamedState,
            {
              agentType: isClaudeAgent ? 'claude-code' : 'codex',
              provider,
              shortCircuitTriggeredErrors: true,
            },
          );
          streamedState = evaluation.state;

          if (
            evaluation.newTrigger &&
            typeof streamedOutput.result === 'string' &&
            streamedOutput.status === 'success'
          ) {
            logger.warn(
              {
                taskId: task.id,
                taskChatJid: task.chat_jid,
                group: context.group.name,
                groupFolder: task.group_folder,
                reason: evaluation.newTrigger.reason,
                resultPreview: streamedOutput.result.slice(0, 120),
              },
              'Detected Claude fallback trigger during scheduled task output',
            );
          } else if (
            evaluation.newTrigger &&
            typeof streamedOutput.error === 'string'
          ) {
            logger.warn(
              {
                taskId: task.id,
                taskChatJid: task.chat_jid,
                group: context.group.name,
                groupFolder: task.group_folder,
                reason: evaluation.newTrigger.reason,
                errorPreview: streamedOutput.error.slice(0, 120),
              },
              provider === 'claude'
                ? 'Detected Claude fallback trigger during scheduled task error output'
                : 'Detected Codex rotation trigger during scheduled task error output',
            );
          }

          if (!evaluation.shouldForwardOutput) {
            if (streamedOutput.status === 'error') {
              attemptError = streamedOutput.error || 'Unknown error';
            }
            return;
          }

          if (streamedOutput.result) {
            attemptResult = streamedOutput.result;
            await deps.sendMessage(task.chat_jid, streamedOutput.result);
          }

          if (streamedOutput.status === 'error') {
            attemptError = streamedOutput.error || 'Unknown error';
          }
        },
        isClaudeAgent && provider !== 'claude'
          ? getFallbackEnvOverrides()
          : undefined,
      );

      if (output.status === 'error' && !attemptError) {
        attemptError = output.error || 'Unknown error';
      } else if (output.result && !attemptResult) {
        attemptResult = output.result;
      }

      return {
        output,
        sawOutput: streamedState.sawOutput,
        streamedTriggerReason: streamedState.streamedTriggerReason,
        attemptResult,
        attemptError,
      };
    };

    const runFallbackTaskAttempt = async (
      reason: AgentTriggerReason,
      retryAfterMs?: number,
    ): Promise<void> => {
      if (!canFallback) {
        error = reason;
        return;
      }

      const fallbackName = getFallbackProviderName();
      markPrimaryCooldown(reason, retryAfterMs);

      logger.info(
        {
          taskId: task.id,
          group: context.group.name,
          groupFolder: task.group_folder,
          reason,
          retryAfterMs,
          fallbackProvider: fallbackName,
        },
        `Falling back to provider: ${fallbackName} for scheduled task (reason: ${reason})`,
      );

      const fallbackAttempt = await runTaskAttempt(fallbackName);
      result = fallbackAttempt.attemptResult;
      error =
        fallbackAttempt.output.status === 'error'
          ? fallbackAttempt.attemptError || 'Unknown error'
          : null;
    };

    const retryClaudeTaskWithRotation = async (
      initialTrigger: {
        reason: AgentTriggerReason;
        retryAfterMs?: number;
      },
      rotationMessage?: string,
    ): Promise<void> => {
      const logCtx = {
        taskId: task.id,
        group: context.group.name,
        groupFolder: task.group_folder,
      };

      const outcome = await runClaudeRotationLoop(
        initialTrigger,
        async () => {
          const attempt = await runTaskAttempt('claude');
          result = attempt.attemptResult;
          error = attempt.attemptError;
          return {
            output: attempt.output,
            sawOutput: attempt.sawOutput,
            streamedTriggerReason: attempt.streamedTriggerReason,
          };
        },
        logCtx,
        rotationMessage,
      );

      switch (outcome.type) {
        case 'success':
          error = null;
          return;
        case 'error':
          return;
        case 'no-fallback':
          error = `Claude ${outcome.trigger.reason}`;
          return;
        case 'needs-fallback':
          await runFallbackTaskAttempt(
            outcome.trigger.reason,
            outcome.trigger.retryAfterMs,
          );
          return;
      }
    };

    const retryCodexTaskWithRotation = async (
      initialTrigger: { reason: CodexRotationReason },
      rotationMessage?: string,
    ): Promise<void> => {
      let trigger = initialTrigger;
      let lastRotationMessage = rotationMessage;

      while (
        getCodexAccountCount() > 1 &&
        rotateCodexToken(lastRotationMessage)
      ) {
        logger.info(
          {
            taskId: task.id,
            group: context.group.name,
            groupFolder: task.group_folder,
            reason: trigger.reason,
          },
          'Codex account unhealthy, retrying scheduled task with rotated account',
        );

        const retryAttempt = await runTaskAttempt('codex');
        result = retryAttempt.attemptResult;
        error = retryAttempt.attemptError;

        if (
          !retryAttempt.sawOutput &&
          retryAttempt.streamedTriggerReason &&
          retryAttempt.output.status !== 'error'
        ) {
          trigger = {
            reason: retryAttempt.streamedTriggerReason
              .reason as CodexRotationReason,
          };
          lastRotationMessage =
            typeof retryAttempt.output.result === 'string'
              ? retryAttempt.output.result
              : undefined;
          continue;
        }

        if (retryAttempt.output.status === 'error') {
          const retryTrigger = retryAttempt.streamedTriggerReason
            ? {
                shouldRotate: true,
                reason: retryAttempt.streamedTriggerReason
                  .reason as CodexRotationReason,
              }
            : detectCodexRotationTrigger(
                retryAttempt.attemptError || retryAttempt.output.error,
              );

          if (retryTrigger.shouldRotate) {
            trigger = { reason: retryTrigger.reason };
            lastRotationMessage =
              retryAttempt.attemptError ||
              retryAttempt.output.error ||
              undefined;
            continue;
          }
          return;
        }

        markCodexTokenHealthy();
        error = null;
        return;
      }
    };

    const provider =
      context.taskAgentType === 'codex'
        ? 'codex'
        : canFallback
          ? await getActiveProvider()
          : 'claude';

    // Already in no-fallback Claude cooldown — skip task instead of running on Kimi
    if (
      isClaudeAgent &&
      provider !== 'claude' &&
      isPrimaryNoFallbackCooldownActive()
    ) {
      logger.info(
        { taskId: task.id, group: context.group.name, provider },
        'Claude primary cooldown active, skipping scheduled task',
      );
      error = 'Claude primary cooldown active';
      // Fall through to task completion handling below
    } else {
      const attempt = await runTaskAttempt(provider);
      result = attempt.attemptResult;
      error = attempt.attemptError;

      if (
        provider === 'claude' &&
        attempt.streamedTriggerReason &&
        !attempt.sawOutput
      ) {
        await retryClaudeTaskWithRotation(attempt.streamedTriggerReason);
      } else if (
        provider === 'codex' &&
        attempt.streamedTriggerReason &&
        !attempt.sawOutput
      ) {
        await retryCodexTaskWithRotation(
          {
            reason: attempt.streamedTriggerReason.reason as CodexRotationReason,
          },
          typeof attempt.output.error === 'string'
            ? attempt.output.error
            : undefined,
        );
      } else if (attempt.output.status === 'error' && provider === 'claude') {
        const trigger = attempt.streamedTriggerReason
          ? {
              shouldFallback: true,
              reason: attempt.streamedTriggerReason.reason,
              retryAfterMs: attempt.streamedTriggerReason.retryAfterMs,
            }
          : detectFallbackTrigger(error);
        if (trigger.shouldFallback) {
          await retryClaudeTaskWithRotation({
            reason: trigger.reason,
            retryAfterMs: trigger.retryAfterMs,
          });
        }
      } else if (attempt.output.status === 'error' && provider === 'codex') {
        const trigger = attempt.streamedTriggerReason
          ? {
              shouldRotate: true,
              reason: attempt.streamedTriggerReason
                .reason as CodexRotationReason,
            }
          : detectCodexRotationTrigger(error);
        if (trigger.shouldRotate) {
          await retryCodexTaskWithRotation(
            { reason: trigger.reason },
            error || undefined,
          );
        }
      } else if (attempt.output.status === 'error') {
        error = attempt.attemptError || 'Unknown error';
      }
    } // end else (non-exhausted path)

    logger.info(
      {
        taskId: task.id,
        agentType: context.taskAgentType,
        durationMs: Date.now() - startTime,
      },
      'Task completed',
    );
  } catch (err) {
    error = getErrorMessage(err);
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
    const isCodex = SERVICE_AGENT_TYPE === 'codex';
    if (isCodex) {
      const trigger = detectCodexRotationTrigger(error);
      if (trigger.shouldRotate) {
        const rotated = getCodexAccountCount() > 1 && rotateCodexToken(error);
        if (rotated) {
          logger.info(
            {
              taskId: task.id,
              agent: SERVICE_AGENT_TYPE,
              reason: trigger.reason,
            },
            'Task rate-limited, rotated token — will retry on next schedule',
          );
          markCodexTokenHealthy();
          // Clear the error so suspension doesn't trigger
          error = null;
        }
      }
    } else {
      const trigger = detectFallbackTrigger(error);
      if (trigger.shouldFallback) {
        const rotated = getTokenCount() > 1 && rotateToken(error);
        if (rotated) {
          logger.info(
            {
              taskId: task.id,
              agent: SERVICE_AGENT_TYPE,
              reason: trigger.reason,
            },
            'Task rate-limited, rotated token — will retry on next schedule',
          );
          markTokenHealthy();
          // Clear the error so suspension doesn't trigger
          error = null;
        }
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

async function runGithubCiTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let result: string | null = null;
  let error: string | null = null;
  let completedAndDeleted = false;
  const statusTracker = createTaskStatusTracker(task, {
    sendTrackedMessage: deps.sendTrackedMessage,
    editTrackedMessage: deps.editTrackedMessage,
  });

  try {
    await statusTracker.update('checking');

    const check = await checkGitHubActionsRun(task);
    result = check.resultSummary;

    if (check.terminal) {
      await statusTracker.update('completed');
      if (check.completionMessage) {
        await deps.sendMessage(task.chat_jid, check.completionMessage);
      }
      deleteTask(task.id);
      completedAndDeleted = true;
      logger.info(
        {
          taskId: task.id,
          groupFolder: task.group_folder,
          durationMs: Date.now() - startTime,
        },
        'GitHub CI watcher completed and deleted',
      );
    } else {
      logger.info(
        {
          taskId: task.id,
          groupFolder: task.group_folder,
          result,
        },
        'GitHub CI watcher checked non-terminal run',
      );
    }
  } catch (err) {
    error = getErrorMessage(err);
    logger.error({ taskId: task.id, error }, 'GitHub CI watcher failed');
  }

  const durationMs = Date.now() - startTime;
  const currentTask = getTaskById(task.id);
  const nextRun = currentTask ? computeNextRun(task) : null;

  if (!currentTask) {
    if (!completedAndDeleted) {
      await statusTracker.update('completed');
    }
    logger.debug(
      { taskId: task.id },
      'GitHub CI watcher deleted during execution, skipping persistence',
    );
    return;
  }

  if (error) {
    await statusTracker.update('retrying', nextRun);
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

  updateTaskAfterRun(
    task.id,
    nextRun,
    error ? `Error: ${error}` : result || 'Completed',
  );
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
      const agentType = deps.serviceAgentType || SERVICE_AGENT_TYPE;
      const nowMs = Date.now();
      const activeTasks = getAllTasks(agentType).filter(
        (task) => task.status === 'active',
      );

      for (const task of activeTasks) {
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        if (!hasTaskExceededMaxDuration(currentTask, nowMs)) {
          continue;
        }

        deleteTask(currentTask.id);
        logger.warn(
          {
            taskId: currentTask.id,
            groupFolder: currentTask.group_folder,
            maxDurationMs: currentTask.max_duration_ms,
            createdAt: currentTask.created_at,
          },
          'Deleted task that exceeded max duration',
        );
      }

      const dueTasks = getDueTasks(agentType);
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
          () =>
            isGitHubCiTask(currentTask)
              ? runGithubCiTask(currentTask, deps)
              : runTask(currentTask, deps),
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
