import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { readJsonFile } from './utils.js';
import { AvailableGroup } from './agent-runner.js';
import {
  type AssignRoomInput,
  createTask,
  deleteTask,
  findDuplicateCiWatcher,
  getTaskById,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  DEFAULT_WATCH_CI_MAX_DURATION_MS,
  isWatchCiTask,
} from './task-watch-status.js';
import { AgentType, RegisteredGroup, RoomMode } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  nudgeScheduler?: () => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  assignRoom: (jid: string, room: AssignRoomInput) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
  ) => void;
}

let ipcWatcherRunning = false;
const IPC_PROCESSING_DIRNAME = '.processing';

function buildIpcErrorPath(
  errorDir: string,
  prefix: string,
  fileName: string,
): string {
  return path.join(errorDir, `${prefix}-${Date.now()}-${fileName}`);
}

export function claimIpcFile(filePath: string): string | null {
  const processingDir = path.join(
    path.dirname(filePath),
    IPC_PROCESSING_DIRNAME,
  );
  fs.mkdirSync(processingDir, { recursive: true });

  const claimedPath = path.join(processingDir, path.basename(filePath));
  try {
    fs.renameSync(filePath, claimedPath);
    return claimedPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export function quarantineClaimedIpcFiles(
  ipcDir: string,
  errorDir: string,
  prefix: string,
): string[] {
  const processingDir = path.join(ipcDir, IPC_PROCESSING_DIRNAME);
  if (!fs.existsSync(processingDir)) {
    return [];
  }

  const movedPaths: string[] = [];
  for (const file of fs
    .readdirSync(processingDir)
    .filter((f) => f.endsWith('.json'))) {
    const claimedPath = path.join(processingDir, file);
    const errorPath = buildIpcErrorPath(errorDir, prefix, file);
    fs.renameSync(claimedPath, errorPath);
    movedPaths.push(errorPath);
  }

  return movedPaths;
}

function moveClaimedIpcFileToError(
  claimedPath: string,
  errorDir: string,
  prefix: string,
): void {
  fs.renameSync(
    claimedPath,
    buildIpcErrorPath(errorDir, prefix, path.basename(claimedPath)),
  );
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
      const errorDir = path.join(ipcBaseDir, 'errors');
      fs.mkdirSync(errorDir, { recursive: true });

      for (const quarantinedPath of quarantineClaimedIpcFiles(
        messagesDir,
        errorDir,
        `${sourceGroup}-message-stale`,
      )) {
        logger.warn(
          { sourceGroup, quarantinedPath },
          'Quarantined previously claimed IPC message after restart',
        );
      }

      for (const quarantinedPath of quarantineClaimedIpcFiles(
        tasksDir,
        errorDir,
        `${sourceGroup}-task-stale`,
      )) {
        logger.warn(
          { sourceGroup, quarantinedPath },
          'Quarantined previously claimed IPC task after restart',
        );
      }

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            const claimedPath = claimIpcFile(filePath);
            if (!claimedPath) continue;
            try {
              const data = readJsonFile(claimedPath);
              if (!data || typeof data !== 'object')
                throw new Error('Invalid JSON');
              const msg = data as {
                type?: string;
                chatJid?: string;
                text?: string;
              };
              if (msg.type === 'message' && msg.chatJid && msg.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[msg.chatJid];
                const isMainOverride = isMain === true;
                if (
                  isMainOverride ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(msg.chatJid, msg.text);
                  logger.info(
                    {
                      transition: 'ipc:auth:allow',
                      chatJid: msg.chatJid,
                      sourceGroup,
                      targetGroup: targetGroup?.folder ?? null,
                      isMainOverride,
                    },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    {
                      transition: 'ipc:auth:deny',
                      chatJid: msg.chatJid,
                      sourceGroup,
                      targetGroup: targetGroup?.folder ?? null,
                      isMainOverride,
                    },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(claimedPath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              moveClaimedIpcFileToError(
                claimedPath,
                errorDir,
                `${sourceGroup}-message-error`,
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            const claimedPath = claimIpcFile(filePath);
            if (!claimedPath) continue;
            try {
              const data = readJsonFile(claimedPath);
              if (!data || typeof data !== 'object')
                throw new Error('Invalid JSON');
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(
                data as Parameters<typeof processTaskIpc>[0],
                sourceGroup,
                isMain,
                deps,
              );
              fs.unlinkSync(claimedPath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              moveClaimedIpcFileToError(
                claimedPath,
                errorDir,
                `${sourceGroup}-task-error`,
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    ci_provider?: 'github';
    ci_metadata?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For assign_room
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    room_mode?: RoomMode;
    owner_agent_type?: AgentType;
    isMain?: boolean;
    workDir?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry =
          registeredGroups[targetJid] ||
          Object.values(registeredGroups).find(
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
          registeredGroups[targetJid] !== undefined
            ? targetJid
            : Object.entries(registeredGroups).find(
                ([, group]) => group.folder === targetFolder,
              )?.[0];

        if (!resolvedTargetJid) {
          logger.warn(
            { targetJid, targetFolder },
            'Cannot resolve scheduled task target JID from folder',
          );
          break;
        }

        // Authorization: non-main groups can only schedule for themselves
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

        // Deduplicate CI watchers: if another agent already watches the same
        // channel + provider + run, skip creation to avoid duplicate notifications.
        if (data.ci_provider && data.ci_metadata) {
          const existing = findDuplicateCiWatcher(
            resolvedTargetJid,
            data.ci_provider,
            data.ci_metadata as string,
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
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
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
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
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
      // Only main group can assign rooms
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

        deps.assignRoom(data.jid, {
          name: data.name,
          roomMode: data.room_mode,
          ownerAgentType: data.owner_agent_type,
          folder: data.folder,
          trigger: data.trigger,
          requiresTrigger: data.requiresTrigger,
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

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
