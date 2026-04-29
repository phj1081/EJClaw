import { CronExpressionParser } from 'cron-parser';
import { getAgentOutputText } from './agent-output.js';
import { createEvaluatedOutputHandler } from './agent-attempt.js';
import {
  executeAttemptRetryAction,
  runClaudeAttemptWithRotation,
  runCodexAttemptWithRotation,
} from './agent-attempt-orchestration.js';
import { getErrorMessage } from './utils.js';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AgentOutput, runAgentProcess } from './agent-runner.js';
import {
  getAllTasks,
  deleteTask,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { createScopedLogger, logger } from './logger.js';
import { createTaskStatusTracker } from './task-status-tracker.js';
import {
  detectCodexRotationTrigger,
  rotateCodexToken,
  getCodexAccountCount,
  markCodexTokenHealthy,
} from './codex-token-rotation.js';
import {
  classifyRotationTrigger,
  type AgentTriggerReason,
  type CodexRotationReason,
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
import { getTaskQueueJid, isGitHubCiTask } from './task-watch-status.js';
import { ScheduledTask } from './types.js';
import {
  hasTaskExceededMaxDuration,
  resolveTaskExecutionContext,
  sendScheduledMessage,
  writeTaskSnapshotForGroup,
} from './task-scheduler-runtime.js';
import { runGithubCiTask } from './task-scheduler-github.js';
import type {
  SchedulerDependencies,
  TaskExecutionContext,
} from './task-scheduler-types.js';
export {
  extractWatchCiTarget,
  getTaskQueueJid,
  getTaskRuntimeTaskId,
  isTaskStatusControlMessage,
  isWatchCiTask,
  renderWatchCiStatusMessage,
  shouldUseTaskScopedSession,
} from './task-watch-status.js';
export type { SchedulerDependencies } from './task-scheduler-types.js';

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
  const log = createScopedLogger({
    taskId: task.id,
    chatJid: task.chat_jid,
    groupName: context.group.name,
    groupFolder: task.group_folder,
    runtimeTaskId: context.runtimeTaskId,
  });

  log.info('Running scheduled task');

  // Update tasks snapshot for agent to read (filtered by group)
  writeTaskSnapshotForGroup(
    context.taskAgentType,
    task.group_folder,
    context.isMain,
    context.runtimeTaskId,
  );

  let result: string | null = null;
  let error: string | null;
  const statusTracker = createTaskStatusTracker(task, {
    sendTrackedMessage: deps.sendTrackedMessage,
    editTrackedMessage: deps.editTrackedMessage,
  });
  const isClaudeAgent = context.taskAgentType === 'claude-code';

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
      let attemptResult: string | null = null;
      let attemptError: string | null = null;
      const streamedOutputHandler = createEvaluatedOutputHandler({
        agentType: isClaudeAgent ? 'claude-code' : 'codex',
        provider,
        evaluationOptions: {
          shortCircuitTriggeredErrors: true,
        },
        onEvaluatedOutput: async ({
          output: streamedOutput,
          outputText,
          evaluation,
        }) => {
          if (streamedOutput.phase === 'progress') {
            return;
          }
          if (
            evaluation.newTrigger &&
            outputText &&
            streamedOutput.status === 'success'
          ) {
            log.warn(
              {
                reason: evaluation.newTrigger.reason,
                resultPreview: outputText.slice(0, 120),
              },
              'Detected Claude rotation trigger during scheduled task output',
            );
          } else if (
            evaluation.newTrigger &&
            typeof streamedOutput.error === 'string'
          ) {
            log.warn(
              {
                reason: evaluation.newTrigger.reason,
                errorPreview: streamedOutput.error.slice(0, 120),
              },
              provider === 'claude'
                ? 'Detected Claude rotation trigger during scheduled task error output'
                : 'Detected Codex rotation trigger during scheduled task error output',
            );
          }

          if (!evaluation.shouldForwardOutput) {
            if (streamedOutput.status === 'error') {
              attemptError = streamedOutput.error || 'Unknown error';
            }
            return;
          }

          if (outputText) {
            attemptResult = outputText;
            // Paired-room scheduler output must use the reviewer bot slot.
            await sendScheduledMessage(deps, task.chat_jid, outputText);
          }

          if (streamedOutput.status === 'error') {
            attemptError = streamedOutput.error || 'Unknown error';
          }
        },
      });

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
        streamedOutputHandler.handleOutput,
        undefined,
      );

      if (output.status === 'error' && !attemptError) {
        attemptError = output.error || 'Unknown error';
      } else {
        const outputText = getAgentOutputText(output);
        if (outputText && !attemptResult) {
          attemptResult = outputText;
        }
      }

      const streamedState = streamedOutputHandler.getState();
      return {
        output,
        sawOutput: streamedState.sawOutput,
        streamedTriggerReason: streamedState.streamedTriggerReason,
        attemptResult,
        attemptError,
      };
    };

    const retryClaudeTaskWithRotation = async (
      initialTrigger: {
        reason: AgentTriggerReason;
        retryAfterMs?: number;
      },
      rotationMessage?: string,
    ): Promise<'success' | 'error'> => {
      const logContext = {
        taskId: task.id,
        group: context.group.name,
        groupFolder: task.group_folder,
      };

      const outcome = await runClaudeAttemptWithRotation({
        initialTrigger,
        runAttempt: () => runTaskAttempt('claude'),
        logContext,
        rotationMessage,
        afterAttempt: (attempt) => {
          result = attempt.attemptResult;
          error = attempt.attemptError;
        },
      });

      if (outcome === 'success') {
        error = null;
      }
      return outcome;
    };

    const retryCodexTaskWithRotation = async (
      initialTrigger: { reason: CodexRotationReason },
      rotationMessage?: string,
    ): Promise<'success' | 'error'> => {
      const outcome = await runCodexAttemptWithRotation({
        initialTrigger,
        runAttempt: () => runTaskAttempt('codex'),
        logContext: {
          taskId: task.id,
          group: context.group.name,
          groupFolder: task.group_folder,
        },
        rotationMessage,
        afterAttempt: (attempt) => {
          result = attempt.attemptResult;
          error = attempt.attemptError;
        },
      });

      if (outcome === 'success') {
        error = null;
      }
      return outcome;
    };

    const provider = context.taskAgentType === 'codex' ? 'codex' : 'claude';

    {
      const attempt = await runTaskAttempt(provider);
      result = attempt.attemptResult;
      error = attempt.attemptError;

      const retryAction = await executeAttemptRetryAction({
        provider,
        canRetryClaudeCredentials: provider === 'claude' && getTokenCount() > 0,
        canRetryCodex: provider === 'codex' && getCodexAccountCount() > 1,
        attempt,
        rotationMessage: error,
        runClaude: retryClaudeTaskWithRotation,
        runCodex: retryCodexTaskWithRotation,
      });

      if (retryAction.kind === 'none' && attempt.output.status === 'error') {
        error = attempt.attemptError || 'Unknown error';
      }
    } // end else (non-exhausted path)

    log.info(
      {
        agentType: context.taskAgentType,
        durationMs: Date.now() - startTime,
      },
      'Task completed',
    );
  } catch (err) {
    error = getErrorMessage(err);
    log.error({ error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;
  const currentTask = getTaskById(task.id);
  const nextRun = currentTask ? computeNextRun(task) : null;

  if (!currentTask) {
    await statusTracker.update('completed');
    log.debug('Task deleted during execution, skipping persistence');
    return;
  }

  // Clear suspension on success
  if (!error && currentTask.suspended_until) {
    updateTask(task.id, { suspended_until: null });
  }

  // Try token rotation before suspending
  if (error) {
    const effectiveAgentType = context.taskAgentType;
    const isCodex = effectiveAgentType === 'codex';
    if (isCodex) {
      const trigger = detectCodexRotationTrigger(error);
      if (trigger.shouldRotate) {
        const rotated = getCodexAccountCount() > 1 && rotateCodexToken(error);
        if (rotated) {
          log.info(
            {
              agent: effectiveAgentType,
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
      const trigger = classifyRotationTrigger(error);
      if (trigger.shouldRetry) {
        const rotated = getTokenCount() > 1 && rotateToken(error);
        if (rotated) {
          log.info(
            {
              agent: effectiveAgentType,
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

/**
 * Execute one scheduler tick without timer/in-flight coordination.
 * This keeps the scheduler loop focused on timing while tests and debugging
 * can exercise the due-task path directly.
 */
export async function runSchedulerTickOnce(
  deps: SchedulerDependencies,
): Promise<void> {
  // Unified service: process all agent types, not just the service default.
  const nowMs = Date.now();
  const activeTasks = getAllTasks().filter((task) => task.status === 'active');

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

  const dueTasks = getDueTasks();
  if (dueTasks.length > 0) {
    logger.info({ count: dueTasks.length }, 'Found due tasks');
  }

  for (const task of dueTasks) {
    // Re-check task status in case it was paused/cancelled
    const currentTask = getTaskById(task.id);
    if (!currentTask || currentTask.status !== 'active') {
      continue;
    }

    deps.queue.enqueueTask(getTaskQueueJid(currentTask), currentTask.id, () =>
      isGitHubCiTask(currentTask)
        ? runGithubCiTask(currentTask, deps)
        : runTask(currentTask, deps),
    );
  }
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
      await runSchedulerTickOnce(deps);
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
