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
  updateTaskStatusTracking,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { AgentType, RegisteredGroup, ScheduledTask } from './types.js';

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
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendTrackedMessage?: (jid: string, text: string) => Promise<string | null>;
  editTrackedMessage?: (
    jid: string,
    messageId: string,
    text: string,
  ) => Promise<void>;
}

type WatcherStatusPhase = 'checking' | 'waiting' | 'retrying' | 'completed';

const WATCH_CI_PREFIX = '[BACKGROUND CI WATCH]';
const TASK_STATUS_MESSAGE_PREFIX = '\u2063\u2063\u2063';

export function isWatchCiTask(task: Pick<ScheduledTask, 'prompt'>): boolean {
  return task.prompt.startsWith(WATCH_CI_PREFIX);
}

export function isTaskStatusControlMessage(content: string): boolean {
  return content.startsWith(TASK_STATUS_MESSAGE_PREFIX);
}

export function extractWatchCiTarget(prompt: string): string | null {
  const match = prompt.match(/Watch target:\n([\s\S]*?)\n\nTask ID:/);
  return match?.[1]?.trim() || null;
}

function formatTimeLabel(timestampIso: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: TIMEZONE,
  })
    .format(new Date(timestampIso))
    .replace(/:/g, '시 ')
    .replace(/시 (\d{2})$/, '분 $1초');
}

function formatWatchIntervalLabel(
  task: Pick<ScheduledTask, 'schedule_type' | 'schedule_value'>,
): string | null {
  if (task.schedule_type !== 'interval') return null;
  const ms = parseInt(task.schedule_value, 10);
  if (!Number.isFinite(ms) || ms <= 0) return null;

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}초`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${totalMinutes}분 ${seconds}초` : `${totalMinutes}분`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
}

export function renderWatchCiStatusMessage(args: {
  task: Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value'>;
  phase: WatcherStatusPhase;
  checkedAt: string;
  nextRun?: string | null;
}): string {
  const target = extractWatchCiTarget(args.task.prompt) || 'CI watcher';
  const title =
    args.phase === 'completed'
      ? `CI 감시 종료: ${target}`
      : `CI 감시 중: ${target}`;
  const statusLabel =
    args.phase === 'checking'
      ? '확인 중'
      : args.phase === 'retrying'
        ? '재시도 대기'
        : args.phase === 'completed'
          ? '완료'
          : '대기 중';

  const lines = [
    title,
    `- 상태: ${statusLabel}`,
    `- 마지막 확인: ${formatTimeLabel(args.checkedAt)}`,
  ];
  const intervalLabel = formatWatchIntervalLabel(args.task);
  if (intervalLabel) {
    lines.push(`- 확인 간격: ${intervalLabel}`);
  }

  if (args.nextRun) {
    lines.push(`- 다음 확인: ${formatTimeLabel(args.nextRun)}`);
  }
  return lines.join('\n');
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
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
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for agent to read (filtered by group)
  const isMain = group.isMain === true;
  const taskAgentType =
    task.agent_type || deps.serviceAgentType || SERVICE_AGENT_TYPE;
  const tasks = getAllTasks(taskAgentType);
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;
  let statusMessageId = task.status_message_id;
  let statusStartedAt = task.status_started_at;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the agent promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task agent after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  const shouldTrackStatus =
    isWatchCiTask(task) &&
    typeof deps.sendTrackedMessage === 'function' &&
    typeof deps.editTrackedMessage === 'function';

  const persistStatusTracking = () => {
    const currentTask = getTaskById(task.id);
    if (!currentTask) return;
    updateTaskStatusTracking(task.id, {
      status_message_id: statusMessageId,
      status_started_at: statusStartedAt,
    });
  };

  const updateWatcherStatus = async (
    phase: WatcherStatusPhase,
    nextRun?: string | null,
  ) => {
    if (!shouldTrackStatus) {
      return;
    }

    const checkedAt = new Date().toISOString();
    if (!statusStartedAt) {
      statusStartedAt = checkedAt;
    }

    const text = renderWatchCiStatusMessage({
      task,
      phase,
      checkedAt,
      nextRun,
    });
    const payload = `${TASK_STATUS_MESSAGE_PREFIX}${text}`;

    if (statusMessageId) {
      try {
        await deps.editTrackedMessage!(task.chat_jid, statusMessageId, payload);
        persistStatusTracking();
        return;
      } catch {
        statusMessageId = null;
        persistStatusTracking();
      }
    }

    const messageId = await deps.sendTrackedMessage!(task.chat_jid, payload);
    if (messageId) {
      statusMessageId = messageId;
      persistStatusTracking();
    }
  };

  try {
    await updateWatcherStatus('checking');

    const output = await runAgentProcess(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, processName) =>
        deps.onProcess(task.chat_jid, proc, processName, task.group_folder),
      async (streamedOutput: AgentOutput) => {
        if (streamedOutput.phase === 'progress') {
          return;
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      {
        taskId: task.id,
        agentType: taskAgentType,
        durationMs: Date.now() - startTime,
      },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;
  const currentTask = getTaskById(task.id);
  const nextRun = currentTask ? computeNextRun(task) : null;

  if (!currentTask) {
    await updateWatcherStatus('completed');
    logger.debug(
      { taskId: task.id },
      'Task deleted during execution, skipping persistence',
    );
    return;
  }

  if (error) {
    await updateWatcherStatus('retrying', nextRun);
  } else if (nextRun) {
    await updateWatcherStatus('waiting', nextRun);
  } else {
    await updateWatcherStatus('completed');
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

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
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

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
