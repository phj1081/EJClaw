import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import type { IpcDeps, TaskIpcPayload } from '../ipc-types.js';
import type { AgentType, RoomMode } from '../types.js';

export async function handleRefreshGroups(
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<void> {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
    return;
  }

  logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
  await deps.syncGroups(true);
  const availableGroups = deps.getAvailableGroups();
  deps.writeGroupsSnapshot(sourceGroup, true, availableGroups);
}

export function handleAssignRoom(
  data: TaskIpcPayload,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): void {
  const validation = validateAssignRoomRequest(data, sourceGroup, isMain);
  if (!validation.ok) return;

  deps.assignRoom(data.jid!, {
    name: data.name!,
    roomMode: data.room_mode,
    ownerAgentType: data.owner_agent_type,
    reviewerAgentType: data.reviewer_agent_type,
    arbiterAgentType: data.arbiter_agent_type,
    folder: data.folder,
    trigger: data.trigger,
    requiresTrigger: data.requiresTrigger,
    isMain: data.isMain,
    workDir: data.workDir,
  });
}

function validateAssignRoomRequest(
  data: TaskIpcPayload,
  sourceGroup: string,
  isMain: boolean,
): { ok: true } | { ok: false } {
  if (!isMain) {
    logger.warn(
      { sourceGroup, type: data.type },
      `Unauthorized ${data.type} attempt blocked`,
    );
    return { ok: false };
  }
  if (!data.jid || !data.name) {
    logger.warn(
      { data },
      `Invalid ${data.type} request - missing required fields`,
    );
    return { ok: false };
  }
  if (data.folder && !isValidGroupFolder(data.folder)) {
    logger.warn(
      { sourceGroup, folder: data.folder },
      `Invalid ${data.type} request - unsafe folder name`,
    );
    return { ok: false };
  }
  if (data.trigger !== undefined && typeof data.trigger !== 'string') {
    logger.warn(
      { sourceGroup, trigger: data.trigger },
      'Invalid assign_room request - trigger must be a string',
    );
    return { ok: false };
  }
  if (
    data.requiresTrigger !== undefined &&
    typeof data.requiresTrigger !== 'boolean'
  ) {
    logger.warn(
      { sourceGroup, requiresTrigger: data.requiresTrigger },
      'Invalid assign_room request - requiresTrigger must be a boolean',
    );
    return { ok: false };
  }
  if (data.room_mode !== undefined && !isRoomMode(data.room_mode)) {
    logger.warn(
      { sourceGroup, roomMode: data.room_mode },
      'Invalid assign_room request - unknown room_mode',
    );
    return { ok: false };
  }
  if (
    data.owner_agent_type !== undefined &&
    !isAssignableAgentType(data.owner_agent_type)
  ) {
    logger.warn(
      { sourceGroup, ownerAgentType: data.owner_agent_type },
      'Invalid assign_room request - unknown owner_agent_type',
    );
    return { ok: false };
  }
  if (
    data.reviewer_agent_type !== undefined &&
    !isAssignableAgentType(data.reviewer_agent_type)
  ) {
    logger.warn(
      { sourceGroup, reviewerAgentType: data.reviewer_agent_type },
      'Invalid assign_room request - unknown reviewer_agent_type',
    );
    return { ok: false };
  }
  if (
    data.arbiter_agent_type !== undefined &&
    data.arbiter_agent_type !== null &&
    !isAssignableAgentType(data.arbiter_agent_type)
  ) {
    logger.warn(
      { sourceGroup, arbiterAgentType: data.arbiter_agent_type },
      'Invalid assign_room request - unknown arbiter_agent_type',
    );
    return { ok: false };
  }
  return { ok: true };
}

function isRoomMode(value: string): value is RoomMode {
  return value === 'single' || value === 'tribunal';
}

function isAssignableAgentType(value: string): value is AgentType {
  return value === 'claude-code' || value === 'codex';
}
