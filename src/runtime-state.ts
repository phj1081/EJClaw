import fs from 'fs';
import path from 'path';

import { listAvailableGroups } from './available-groups.js';
import {
  type AssignRoomInput,
  assignRoom,
  deleteAllSessionsForGroup,
  deleteSession,
  getAllRoomBindings,
  getAllSessions,
  getRouterState,
  setRouterState,
  setSession,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { normalizeStoredSeqCursor } from './message-cursor.js';
import type { AgentType, RegisteredGroup } from './types.js';

export interface RuntimeState {
  loadState: () => void;
  saveState: () => void;
  clearSession: (groupFolder: string, opts?: { allRoles?: boolean }) => void;
  assignRoomForIpc: (jid: string, input: AssignRoomInput) => void;
  getAvailableGroups: () => import('./agent-runner.js').AvailableGroup[];
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  getLastAgentTimestamps: () => Record<string, string>;
  getSessions: () => Record<string, string>;
  persistSession: (groupFolder: string, sessionId: string) => void;
  getRoomBindings: () => Record<string, RegisteredGroup>;
  setRoomBindings: (groups: Record<string, RegisteredGroup>) => void;
}

export function createRuntimeState(): RuntimeState {
  let lastTimestamp = '';
  let sessions: Record<string, string> = {};
  let roomBindings: Record<string, RegisteredGroup> = {};
  let lastAgentTimestamp: Record<string, string> = {};

  const saveState = (): void => {
    setRouterState('last_seq', lastTimestamp);
    setRouterState('last_agent_seq', JSON.stringify(lastAgentTimestamp));
  };

  const clearSession = (
    groupFolder: string,
    opts?: { allRoles?: boolean },
  ): void => {
    delete sessions[groupFolder];
    if (opts?.allRoles) {
      deleteAllSessionsForGroup(groupFolder);
    } else {
      deleteSession(groupFolder);
    }
  };

  const persistSession = (groupFolder: string, sessionId: string): void => {
    sessions[groupFolder] = sessionId;
    setSession(groupFolder, sessionId);
  };

  const loadState = (): void => {
    lastTimestamp = normalizeStoredSeqCursor(getRouterState('last_seq'));
    const agentTs = getRouterState('last_agent_seq');
    try {
      const parsed = agentTs
        ? (JSON.parse(agentTs) as Record<string, string>)
        : {};
      lastAgentTimestamp = Object.fromEntries(
        Object.entries(parsed).map(([chatJid, cursor]) => [
          chatJid,
          normalizeStoredSeqCursor(cursor, chatJid),
        ]),
      );
    } catch {
      logger.warn('Corrupted last_agent_seq in DB, resetting');
      lastAgentTimestamp = {};
    }
    sessions = getAllSessions();
    roomBindings = getAllRoomBindings();
    logger.info(
      {
        groupCount: Object.keys(roomBindings).length,
        agentType: 'unified' satisfies AgentType | 'unified',
      },
      'State loaded',
    );
  };

  const assignRoomForIpc = (jid: string, input: AssignRoomInput): void => {
    const assignedGroup = assignRoom(jid, input);
    if (!assignedGroup) {
      logger.warn({ jid }, 'Failed to assign room from IPC');
      return;
    }

    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(assignedGroup.folder);
    } catch (err) {
      logger.warn(
        { jid, folder: assignedGroup.folder, err },
        'Rejecting room assignment with invalid folder',
      );
      return;
    }

    const { jid: _ignoredJid, ...storedGroup } = assignedGroup;
    roomBindings[jid] = storedGroup;
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  };

  return {
    loadState,
    saveState,
    clearSession,
    assignRoomForIpc,
    getAvailableGroups: () => listAvailableGroups(roomBindings),
    getLastTimestamp: () => lastTimestamp,
    setLastTimestamp: (timestamp) => {
      lastTimestamp = timestamp;
    },
    getLastAgentTimestamps: () => lastAgentTimestamp,
    getSessions: () => sessions,
    persistSession,
    getRoomBindings: () => roomBindings,
    setRoomBindings: (groups) => {
      roomBindings = groups;
    },
  };
}
