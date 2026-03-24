import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

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
  isUsageExhausted,
  markPrimaryCooldown,
} from './provider-fallback.js';
import {
  detectCodexRotationTrigger,
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

function isClaudeUsageExhaustedMessage(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^error:\s*/i, '');
  const looksLikeBanner =
    normalized.startsWith("you're out of extra usage") ||
    normalized.startsWith('you are out of extra usage') ||
    normalized.startsWith("you've hit your limit") ||
    normalized.startsWith('you have hit your limit');
  const hasResetHint =
    normalized.includes('resets ') ||
    normalized.includes('reset at ') ||
    normalized.includes('try again');
  return looksLikeBanner && hasResetHint && normalized.length <= 160;
}

function isClaudeAuthExpiredMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const looksLikeAuthFailure = normalized.startsWith(
    'failed to authenticate',
  );
  const hasExpiredTokenMarker =
    normalized.includes('oauth token has expired') ||
    normalized.includes('authentication_error') ||
    normalized.includes('obtain a new token') ||
    normalized.includes('refresh your existing token') ||
    normalized.includes('invalid authentication credentials');
  const hasUnauthorizedMarker =
    normalized.includes('401') || normalized.includes('authentication error');
  const hasTerminatedMarker = normalized.includes('terminated');

  return (
    looksLikeAuthFailure &&
    hasUnauthorizedMarker &&
    (hasExpiredTokenMarker || hasTerminatedMarker)
  );
}

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
  const settingsPath = path.join(
    DATA_DIR,
    'sessions',
    task.group_folder,
    '.claude',
    'settings.json',
  );
  const canFallback =
    context.taskAgentType === 'claude-code' &&
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
        reason: string;
        retryAfterMs?: number;
      };
      attemptResult: string | null;
      attemptError: string | null;
    }> => {
      let sawOutput = false;
      let attemptResult: string | null = null;
      let attemptError: string | null = null;
      let streamedTriggerReason:
        | {
            reason: string;
            retryAfterMs?: number;
          }
        | undefined;

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

          if (
            canFallback &&
            provider === 'claude' &&
            !sawOutput &&
            streamedOutput.status === 'success' &&
            typeof streamedOutput.result === 'string' &&
            (isClaudeUsageExhaustedMessage(streamedOutput.result) ||
              isClaudeAuthExpiredMessage(streamedOutput.result))
          ) {
            if (!streamedTriggerReason) {
              const reason = isClaudeUsageExhaustedMessage(
                streamedOutput.result,
              )
                ? 'usage-exhausted'
                : 'auth-expired';
              logger.warn(
                {
                  taskId: task.id,
                  taskChatJid: task.chat_jid,
                  group: context.group.name,
                  groupFolder: task.group_folder,
                  reason,
                  resultPreview: streamedOutput.result.slice(0, 120),
                },
                'Detected Claude fallback trigger during scheduled task output',
              );
            }
            streamedTriggerReason = {
              reason: isClaudeUsageExhaustedMessage(streamedOutput.result)
                ? 'usage-exhausted'
                : 'auth-expired',
            };
            return;
          }

          if (streamedOutput.result) {
            sawOutput = true;
            attemptResult = streamedOutput.result;
            await deps.sendMessage(task.chat_jid, streamedOutput.result);
          }

          if (streamedOutput.status === 'error') {
            attemptError = streamedOutput.error || 'Unknown error';
            if (!sawOutput && !streamedTriggerReason) {
              const trigger = detectFallbackTrigger(streamedOutput.error);
              if (trigger.shouldFallback) {
                streamedTriggerReason = {
                  reason: trigger.reason,
                  retryAfterMs: trigger.retryAfterMs,
                };
              }
            }
          }
        },
        provider === 'claude' ? undefined : getFallbackEnvOverrides(),
      );

      if (output.status === 'error' && !attemptError) {
        attemptError = output.error || 'Unknown error';
      } else if (output.result && !attemptResult) {
        attemptResult = output.result;
      }

      return {
        output,
        sawOutput,
        streamedTriggerReason,
        attemptResult,
        attemptError,
      };
    };

    const shouldRotateClaudeToken = (reason: string): boolean =>
      reason === '429' ||
      reason === 'usage-exhausted' ||
      reason === 'auth-expired';

    const runFallbackTaskAttempt = async (
      reason: string,
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
        reason: string;
        retryAfterMs?: number;
      },
      rotationMessage?: string,
    ): Promise<void> => {
      let trigger = initialTrigger;
      let lastRotationMessage = rotationMessage;

      while (
        shouldRotateClaudeToken(trigger.reason) &&
        getTokenCount() > 1 &&
        rotateToken(lastRotationMessage, { ignoreRateLimits: true })
      ) {
        logger.info(
          {
            taskId: task.id,
            group: context.group.name,
            groupFolder: task.group_folder,
            reason: trigger.reason,
          },
          'Scheduled task Claude rate-limited, retrying with rotated account',
        );

        const retryAttempt = await runTaskAttempt('claude');
        result = retryAttempt.attemptResult;
        error = retryAttempt.attemptError;

        if (
          retryAttempt.streamedTriggerReason &&
          !retryAttempt.sawOutput &&
          retryAttempt.output.status !== 'error'
        ) {
          trigger = {
            reason: retryAttempt.streamedTriggerReason.reason,
            retryAfterMs: retryAttempt.streamedTriggerReason.retryAfterMs,
          };
          lastRotationMessage =
            typeof retryAttempt.output.result === 'string'
              ? retryAttempt.output.result
              : undefined;
          continue;
        }

        if (retryAttempt.output.status === 'error' && !retryAttempt.sawOutput) {
          const retryTrigger = retryAttempt.streamedTriggerReason
            ? {
                shouldFallback: true,
                reason: retryAttempt.streamedTriggerReason.reason,
                retryAfterMs: retryAttempt.streamedTriggerReason.retryAfterMs,
              }
            : detectFallbackTrigger(retryAttempt.attemptError);
          if (retryTrigger.shouldFallback) {
            trigger = {
              reason: retryTrigger.reason,
              retryAfterMs: retryTrigger.retryAfterMs,
            };
            lastRotationMessage = retryAttempt.attemptError || undefined;
            continue;
          }
        }

        if (retryAttempt.output.status === 'success') {
          markTokenHealthy();
          error = null;
          return;
        }

        return;
      }

      // Usage exhausted: don't fall back to Kimi — just mark cooldown and skip
      if (trigger.reason === 'usage-exhausted') {
        markPrimaryCooldown(trigger.reason, trigger.retryAfterMs);
        logger.info(
          { taskId: task.id, group: context.group.name },
          'All Claude tokens usage-exhausted, skipping Kimi fallback for scheduled task',
        );
        error = 'Claude usage exhausted';
        return;
      }

      await runFallbackTaskAttempt(trigger.reason, trigger.retryAfterMs);
    };

    const provider = canFallback ? await getActiveProvider() : 'claude';

    // Already in usage-exhausted cooldown — skip task instead of running on Kimi
    if (provider !== 'claude' && isUsageExhausted()) {
      logger.info(
        { taskId: task.id, group: context.group.name, provider },
        'Claude usage exhausted (cooldown active), skipping scheduled task',
      );
      error = 'Claude usage exhausted';
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
