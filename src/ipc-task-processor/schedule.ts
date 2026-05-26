import { CronExpressionParser } from 'cron-parser';

import { createTask, findDuplicateCiWatcher } from '../db.js';
import { normalizeStoredAgentType } from '../db/room-registration.js';
import { TIMEZONE } from '../config.js';
import { logger } from '../logger.js';
import {
  DEFAULT_WATCH_CI_MAX_DURATION_MS,
  isWatchCiTask,
} from '../task-watch-status.js';
import type { IpcDeps, TaskIpcPayload } from '../ipc-types.js';
import type { PairedRoomRole, RegisteredGroup } from '../types.js';

type RoomBindings = ReturnType<IpcDeps['roomBindings']>;
type ScheduleType = 'cron' | 'interval' | 'once';

interface ResolvedScheduleTarget {
  folder: string;
  jid: string;
  room: RegisteredGroup;
}

function normalizePairedRoomRole(
  role: string | null | undefined,
): PairedRoomRole | undefined {
  return role === 'owner' || role === 'reviewer' || role === 'arbiter'
    ? role
    : undefined;
}

export function handleScheduleTask(
  data: TaskIpcPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): void {
  if (!hasRequiredScheduleFields(data)) return;

  const roomBindings = deps.roomBindings();
  const target = resolveScheduleTarget(data.targetJid, roomBindings);
  if (!target) return;

  if (!isMain && target.folder !== sourceGroup) {
    logger.warn(
      { sourceGroup, targetFolder: target.folder },
      'Unauthorized schedule_task attempt blocked',
    );
    return;
  }

  const scheduleType = data.schedule_type as ScheduleType;
  const nextRunResult = resolveNextRun(data, scheduleType);
  if (!nextRunResult.ok) return;

  if (isDuplicateCiWatcher(data, target.jid, sourceGroup)) return;

  const taskId =
    data.taskId ||
    `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contextMode =
    data.context_mode === 'group' || data.context_mode === 'isolated'
      ? data.context_mode
      : 'isolated';
  const scheduledAgentType =
    normalizeStoredAgentType(data.agent_type) ??
    target.room.agentType ??
    'claude-code';
  const scheduledRoomRole = normalizePairedRoomRole(data.room_role);

  createTask({
    id: taskId,
    group_folder: target.folder,
    chat_jid: target.jid,
    agent_type: scheduledAgentType,
    room_role: scheduledRoomRole ?? null,
    ci_provider: data.ci_provider ?? null,
    ci_metadata: data.ci_metadata ?? null,
    max_duration_ms: isWatchCiTask({ prompt: data.prompt })
      ? DEFAULT_WATCH_CI_MAX_DURATION_MS
      : null,
    prompt: data.prompt,
    schedule_type: scheduleType,
    schedule_value: data.schedule_value,
    context_mode: contextMode,
    next_run: nextRunResult.nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  logger.info(
    {
      taskId,
      sourceGroup,
      targetFolder: target.folder,
      contextMode,
      agentType: scheduledAgentType,
      roomRole: scheduledRoomRole ?? null,
    },
    'Task created via IPC',
  );
  if (
    nextRunResult.nextRun &&
    new Date(nextRunResult.nextRun).getTime() <= Date.now()
  ) {
    deps.nudgeScheduler?.();
  }
}

function hasRequiredScheduleFields(
  data: TaskIpcPayload,
): data is TaskIpcPayload & {
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  targetJid: string;
} {
  return Boolean(
    data.prompt && data.schedule_type && data.schedule_value && data.targetJid,
  );
}

function resolveScheduleTarget(
  targetJid: string,
  roomBindings: RoomBindings,
): ResolvedScheduleTarget | null {
  const targetRoom =
    roomBindings[targetJid] ||
    Object.values(roomBindings).find((group) => group.folder === targetJid);

  if (!targetRoom) {
    logger.warn(
      { targetJid },
      'Cannot schedule task: target group not registered',
    );
    return null;
  }

  const resolvedTargetJid =
    roomBindings[targetJid] !== undefined
      ? targetJid
      : Object.entries(roomBindings).find(
          ([, group]) => group.folder === targetRoom.folder,
        )?.[0];

  if (!resolvedTargetJid) {
    logger.warn(
      { targetJid, targetFolder: targetRoom.folder },
      'Cannot resolve scheduled task target JID from folder',
    );
    return null;
  }

  return {
    folder: targetRoom.folder,
    jid: resolvedTargetJid,
    room: targetRoom,
  };
}

function isDuplicateCiWatcher(
  data: TaskIpcPayload,
  targetJid: string,
  sourceGroup: string,
): boolean {
  if (!data.ci_provider || !data.ci_metadata) return false;

  const existing = findDuplicateCiWatcher(
    targetJid,
    data.ci_provider,
    data.ci_metadata,
  );
  if (!existing) return false;

  logger.info(
    {
      existingTaskId: existing.id,
      existingAgentType: existing.agent_type,
      ciProvider: data.ci_provider,
      sourceGroup,
    },
    'Duplicate CI watcher skipped — another agent already watches this run',
  );
  return true;
}

function resolveNextRun(
  data: TaskIpcPayload & { prompt?: string; schedule_value?: string },
  scheduleType: ScheduleType,
): { ok: true; nextRun: string | null } | { ok: false } {
  if (scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(data.schedule_value!, {
        tz: TIMEZONE,
      });
      return { ok: true, nextRun: interval.next().toISOString() };
    } catch {
      logger.warn(
        { scheduleValue: data.schedule_value },
        'Invalid cron expression',
      );
      return { ok: false };
    }
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(data.schedule_value!, 10);
    if (isNaN(ms) || ms <= 0) {
      logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
      return { ok: false };
    }
    return {
      ok: true,
      nextRun: isWatchCiTask({ prompt: data.prompt! })
        ? new Date().toISOString()
        : new Date(Date.now() + ms).toISOString(),
    };
  }

  if (scheduleType === 'once') {
    const date = new Date(data.schedule_value!);
    if (isNaN(date.getTime())) {
      logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
      return { ok: false };
    }
    return { ok: true, nextRun: date.toISOString() };
  }

  return { ok: true, nextRun: null };
}
