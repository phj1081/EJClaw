import { CronExpressionParser } from 'cron-parser';

import { getTaskById, updateTask } from '../db.js';
import { TIMEZONE } from '../config.js';
import { logger } from '../logger.js';
import type { TaskIpcPayload } from '../ipc-types.js';

type ScheduleType = 'cron' | 'interval' | 'once';
type TaskUpdates = Parameters<typeof updateTask>[1];
type NextRunResolution = { abort: true } | { abort: false; nextRun?: string };

export function handleTaskStateMutation(
  data: TaskIpcPayload,
  sourceGroup: string,
  isMain: boolean,
  config: {
    action: () => void;
    successMessage: string;
    unauthorizedMessage: string;
  },
): void {
  if (!data.taskId) return;

  const task = getTaskById(data.taskId);
  if (task && (isMain || task.group_folder === sourceGroup)) {
    config.action();
    logger.info({ taskId: data.taskId, sourceGroup }, config.successMessage);
  } else {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      config.unauthorizedMessage,
    );
  }
}

export function handleUpdateTask(
  data: TaskIpcPayload,
  sourceGroup: string,
  isMain: boolean,
): void {
  if (!data.taskId) return;

  const task = getTaskById(data.taskId);
  if (!task) {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      'Task not found for update',
    );
    return;
  }
  if (!isMain && task.group_folder !== sourceGroup) {
    logger.warn(
      { taskId: data.taskId, sourceGroup },
      'Unauthorized task update attempt',
    );
    return;
  }

  const updates = buildTaskUpdates(data, {
    scheduleType: task.schedule_type,
    scheduleValue: task.schedule_value,
  });
  if (!updates) return;

  updateTask(data.taskId, updates);
  logger.info(
    { taskId: data.taskId, sourceGroup, updates },
    'Task updated via IPC',
  );
}

function buildTaskUpdates(
  data: TaskIpcPayload,
  existing: { scheduleType: string; scheduleValue: string },
): TaskUpdates | null {
  const updates: TaskUpdates = {};
  if (data.prompt !== undefined) updates.prompt = data.prompt;
  if (data.schedule_type !== undefined) {
    updates.schedule_type = data.schedule_type as ScheduleType;
  }
  if (data.schedule_value !== undefined) {
    updates.schedule_value = data.schedule_value;
  }

  if (data.schedule_type || data.schedule_value) {
    const updatedScheduleType = updates.schedule_type ?? existing.scheduleType;
    const updatedScheduleValue =
      updates.schedule_value ?? existing.scheduleValue;
    const nextRunResolution = resolveUpdatedNextRun({
      scheduleType: updatedScheduleType,
      scheduleValue: updatedScheduleValue,
      taskId: data.taskId,
    });
    if (nextRunResolution.abort) return null;
    if (nextRunResolution.nextRun !== undefined) {
      updates.next_run = nextRunResolution.nextRun;
    }
  }

  return updates;
}

function resolveUpdatedNextRun(args: {
  scheduleType: string | undefined;
  scheduleValue: string | null | undefined;
  taskId: string | undefined;
}): NextRunResolution {
  if (args.scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(args.scheduleValue ?? '', {
        tz: TIMEZONE,
      });
      return {
        abort: false,
        nextRun: interval.next().toISOString() ?? undefined,
      };
    } catch {
      logger.warn(
        { taskId: args.taskId, value: args.scheduleValue },
        'Invalid cron in task update',
      );
      return { abort: true };
    }
  }

  if (args.scheduleType === 'interval') {
    const ms = parseInt(args.scheduleValue ?? '', 10);
    return {
      abort: false,
      nextRun:
        !isNaN(ms) && ms > 0
          ? new Date(Date.now() + ms).toISOString()
          : undefined,
    };
  }

  return { abort: false };
}
