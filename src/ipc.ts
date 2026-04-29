import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from './config.js';
import { readJsonFile } from './utils.js';
import { logger } from './logger.js';
import {
  claimIpcFile,
  moveClaimedIpcFileToError,
  quarantineClaimedIpcFiles,
} from './ipc-file-claims.js';
import { forwardAuthorizedIpcMessage } from './ipc-message-forwarding.js';
import { processTaskIpc } from './ipc-task-processor.js';
import type {
  IpcDeps,
  IpcMessagePayload,
  TaskIpcPayload,
} from './ipc-types.js';

export type {
  IpcDeps,
  IpcMessageForwardResult,
  IpcMessagePayload,
  TaskIpcPayload,
} from './ipc-types.js';
export {
  claimIpcFile,
  forwardAuthorizedIpcMessage,
  processTaskIpc,
  quarantineClaimedIpcFiles,
};

let ipcWatcherRunning = false;

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

    const roomBindings = deps.roomBindings();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(roomBindings)) {
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
              const msg = data as IpcMessagePayload;
              const forwardResult = await forwardAuthorizedIpcMessage(
                msg,
                sourceGroup,
                isMain,
                roomBindings,
                deps.sendMessage,
                deps.injectInboundMessage,
              );
              if (forwardResult.outcome === 'sent') {
                logger.info(
                  {
                    transition: 'ipc:auth:allow',
                    chatJid: forwardResult.chatJid,
                    sourceGroup,
                    targetGroup: forwardResult.targetGroup ?? null,
                    isMainOverride: forwardResult.isMainOverride,
                    senderRole: forwardResult.senderRole ?? null,
                  },
                  'IPC message sent',
                );
              } else if (forwardResult.outcome === 'blocked') {
                logger.warn(
                  {
                    transition: 'ipc:auth:deny',
                    chatJid: forwardResult.chatJid,
                    sourceGroup,
                    targetGroup: forwardResult.targetGroup ?? null,
                    isMainOverride: forwardResult.isMainOverride,
                    senderRole: forwardResult.senderRole ?? null,
                  },
                  'Unauthorized IPC message attempt blocked',
                );
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
                data as TaskIpcPayload,
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
