import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';
import {
  isHostEvidenceAction,
  runHostEvidenceRequest,
  writeHostEvidenceResponse,
} from './host-evidence.js';
import {
  createTask,
  deleteTask,
  findDuplicateCiWatcher,
  getTaskById,
  rememberMemory,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  DEFAULT_WATCH_CI_MAX_DURATION_MS,
  isWatchCiTask,
} from './task-watch-status.js';
import type { IpcDeps, TaskIpcPayload } from './ipc-types.js';

export async function processTaskIpc(
  data: TaskIpcPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  const roomBindings = deps.roomBindings();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        const targetJid = data.targetJid;
        const targetGroupEntry =
          roomBindings[targetJid] ||
          Object.values(roomBindings).find(
            (group) => group.folder === targetJid,
          );

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;
        const resolvedTargetJid =
          roomBindings[targetJid] !== undefined
            ? targetJid
            : Object.entries(roomBindings).find(
                ([, group]) => group.folder === targetFolder,
              )?.[0];

        if (!resolvedTargetJid) {
          logger.warn(
            { targetJid, targetFolder },
            'Cannot resolve scheduled task target JID from folder',
          );
          break;
        }

        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = isWatchCiTask({ prompt: data.prompt })
            ? new Date().toISOString()
            : new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        if (data.ci_provider && data.ci_metadata) {
          const existing = findDuplicateCiWatcher(
            resolvedTargetJid,
            data.ci_provider,
            data.ci_metadata,
          );
          if (existing) {
            logger.info(
              {
                existingTaskId: existing.id,
                existingAgentType: existing.agent_type,
                ciProvider: data.ci_provider,
                sourceGroup,
              },
              'Duplicate CI watcher skipped — another agent already watches this run',
            );
            break;
          }
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: resolvedTargetJid,
          agent_type: targetGroupEntry.agentType || 'claude-code',
          ci_provider: data.ci_provider ?? null,
          ci_metadata: data.ci_metadata ?? null,
          max_duration_ms: isWatchCiTask({ prompt: data.prompt })
            ? DEFAULT_WATCH_CI_MAX_DURATION_MS
            : null,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          {
            taskId,
            sourceGroup,
            targetFolder,
            contextMode,
            agentType: targetGroupEntry.agentType || 'claude-code',
          },
          'Task created via IPC',
        );
        if (nextRun && new Date(nextRun).getTime() <= Date.now()) {
          deps.nudgeScheduler?.();
        }
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'host_evidence_request':
      if (!data.requestId) {
        logger.warn(
          { sourceGroup },
          'Ignoring host_evidence_request without requestId',
        );
        break;
      }

      if (data.action === 'ejclaw_room_runtime') {
        if (!data.chatJid) {
          writeHostEvidenceResponse(sourceGroup, {
            requestId: data.requestId,
            ok: false,
            action: 'ejclaw_room_runtime',
            command: 'internal:ejclaw_room_runtime',
            stdout: '',
            stderr: '',
            exitCode: 1,
            error: 'Missing chatJid for ejclaw_room_runtime request',
          });
          logger.warn(
            { sourceGroup, requestId: data.requestId },
            'Rejected ejclaw_room_runtime request without chatJid',
          );
          break;
        }

        if (!deps.getRoomRuntimeReport) {
          writeHostEvidenceResponse(sourceGroup, {
            requestId: data.requestId,
            ok: false,
            action: 'ejclaw_room_runtime',
            command: 'internal:ejclaw_room_runtime',
            stdout: '',
            stderr: '',
            exitCode: 1,
            error: 'Room runtime reporting is not configured',
          });
          logger.warn(
            { sourceGroup, requestId: data.requestId, chatJid: data.chatJid },
            'Rejected ejclaw_room_runtime request because runtime reporter is unavailable',
          );
          break;
        }

        const report = deps.getRoomRuntimeReport({
          chatJid: data.chatJid,
          sourceGroup,
          isMain,
        });
        writeHostEvidenceResponse(sourceGroup, {
          requestId: data.requestId,
          ok: true,
          action: 'ejclaw_room_runtime',
          command: 'internal:ejclaw_room_runtime',
          stdout: JSON.stringify(report, null, 2),
          stderr: '',
          exitCode: 0,
        });
        logger.info(
          {
            sourceGroup,
            requestId: data.requestId,
            action: data.action,
            chatJid: data.chatJid,
          },
          'Processed room runtime report request via IPC',
        );
        break;
      }

      if (!isHostEvidenceAction(data.action)) {
        writeHostEvidenceResponse(sourceGroup, {
          requestId: data.requestId,
          ok: false,
          action: 'ejclaw_service_status',
          command: '',
          stdout: '',
          stderr: '',
          exitCode: 1,
          error: `Unsupported host evidence action: ${String(data.action)}`,
        });
        logger.warn(
          { sourceGroup, requestId: data.requestId, action: data.action },
          'Rejected unsupported host evidence action',
        );
        break;
      }

      {
        const result = await runHostEvidenceRequest({
          requestId: data.requestId,
          action: data.action,
          tailLines:
            typeof data.tail_lines === 'number' ? data.tail_lines : undefined,
        });

        writeHostEvidenceResponse(sourceGroup, {
          requestId: data.requestId,
          ...result,
        });

        logger.info(
          {
            sourceGroup,
            requestId: data.requestId,
            action: data.action,
            ok: result.ok,
            exitCode: result.exitCode,
          },
          'Processed host evidence request via IPC',
        );
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined) {
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        }
        if (data.schedule_value !== undefined) {
          updates.schedule_value = data.schedule_value;
        }

        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(sourceGroup, true, availableGroups);
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'assign_room':
      if (!isMain) {
        logger.warn(
          { sourceGroup, type: data.type },
          `Unauthorized ${data.type} attempt blocked`,
        );
        break;
      }
      if (data.jid && data.name) {
        if (data.folder && !isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            `Invalid ${data.type} request - unsafe folder name`,
          );
          break;
        }
        if (
          data.room_mode !== undefined &&
          data.room_mode !== 'single' &&
          data.room_mode !== 'tribunal'
        ) {
          logger.warn(
            { sourceGroup, roomMode: data.room_mode },
            'Invalid assign_room request - unknown room_mode',
          );
          break;
        }
        if (
          data.owner_agent_type !== undefined &&
          data.owner_agent_type !== 'claude-code' &&
          data.owner_agent_type !== 'codex'
        ) {
          logger.warn(
            { sourceGroup, ownerAgentType: data.owner_agent_type },
            'Invalid assign_room request - unknown owner_agent_type',
          );
          break;
        }
        if (
          data.reviewer_agent_type !== undefined &&
          data.reviewer_agent_type !== 'claude-code' &&
          data.reviewer_agent_type !== 'codex'
        ) {
          logger.warn(
            { sourceGroup, reviewerAgentType: data.reviewer_agent_type },
            'Invalid assign_room request - unknown reviewer_agent_type',
          );
          break;
        }
        if (
          data.arbiter_agent_type !== undefined &&
          data.arbiter_agent_type !== null &&
          data.arbiter_agent_type !== 'claude-code' &&
          data.arbiter_agent_type !== 'codex'
        ) {
          logger.warn(
            { sourceGroup, arbiterAgentType: data.arbiter_agent_type },
            'Invalid assign_room request - unknown arbiter_agent_type',
          );
          break;
        }

        deps.assignRoom(data.jid, {
          name: data.name,
          roomMode: data.room_mode,
          ownerAgentType: data.owner_agent_type,
          reviewerAgentType: data.reviewer_agent_type,
          arbiterAgentType: data.arbiter_agent_type,
          folder: data.folder,
          isMain: data.isMain,
          workDir: data.workDir,
        });
      } else {
        logger.warn(
          { data },
          `Invalid ${data.type} request - missing required fields`,
        );
      }
      break;

    case 'persist_memory': {
      if (
        data.scopeKind !== 'room' ||
        typeof data.scopeKey !== 'string' ||
        typeof data.content !== 'string'
      ) {
        logger.warn(
          { sourceGroup, data },
          'Invalid persist_memory request - missing required fields',
        );
        break;
      }

      const expectedScopeKey = `room:${sourceGroup}`;
      if (data.scopeKey !== expectedScopeKey) {
        logger.warn(
          { sourceGroup, scopeKey: data.scopeKey, expectedScopeKey },
          'Unauthorized persist_memory attempt blocked',
        );
        break;
      }

      if (
        data.source_kind !== undefined &&
        data.source_kind !== 'compact' &&
        data.source_kind !== 'explicit' &&
        data.source_kind !== 'import' &&
        data.source_kind !== 'system'
      ) {
        logger.warn(
          { sourceGroup, sourceKind: data.source_kind },
          'Invalid persist_memory request - unknown source_kind',
        );
        break;
      }

      if (
        Array.isArray(data.keywords) &&
        !data.keywords.every((value) => typeof value === 'string')
      ) {
        logger.warn(
          { sourceGroup, keywords: data.keywords },
          'Invalid persist_memory request - keywords must be strings',
        );
        break;
      }

      rememberMemory({
        scopeKind: 'room',
        scopeKey: data.scopeKey,
        content: data.content,
        keywords: data.keywords,
        memoryKind:
          typeof data.memory_kind === 'string' ? data.memory_kind : null,
        sourceKind:
          (data.source_kind as
            | 'compact'
            | 'explicit'
            | 'import'
            | 'system'
            | undefined) ?? 'compact',
        sourceRef: typeof data.source_ref === 'string' ? data.source_ref : null,
      });
      logger.info(
        {
          sourceGroup,
          scopeKey: data.scopeKey,
          sourceKind: data.source_kind ?? 'compact',
        },
        'Memory persisted via IPC',
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
