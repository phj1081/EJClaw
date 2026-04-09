import { Database } from 'bun:sqlite';

import {
  ARBITER_AGENT_TYPE,
  REVIEWER_AGENT_TYPE,
} from '../config.js';
import {
  collectRegisteredAgentTypes,
  collectRegisteredAgentTypesForFolder,
  getStoredRoomSettingsRowFromDatabase,
  inferOwnerAgentTypeFromRegisteredAgentTypes,
  normalizeStoredAgentType,
} from './room-registration.js';
import type { AgentType, PairedRoomRole } from '../types.js';

interface StablePairedTaskRowInput {
  chat_jid: string;
  group_folder: string;
  owner_agent_type?: string | null;
}

export function resolveStablePairedTaskOwnerAgentType(
  database: Database,
  task: StablePairedTaskRowInput,
): AgentType | undefined {
  const persistedOwnerAgentType = normalizeStoredAgentType(
    task.owner_agent_type,
  );
  if (persistedOwnerAgentType) {
    return persistedOwnerAgentType;
  }

  const stored = getStoredRoomSettingsRowFromDatabase(database, task.chat_jid);
  if (stored?.ownerAgentType) {
    return stored.ownerAgentType;
  }

  const jidAgentTypes = collectRegisteredAgentTypes(database, task.chat_jid);
  if (jidAgentTypes.length > 0) {
    return inferOwnerAgentTypeFromRegisteredAgentTypes(jidAgentTypes);
  }

  const folderAgentTypes = collectRegisteredAgentTypesForFolder(
    database,
    task.group_folder,
  );
  if (folderAgentTypes.length > 0) {
    return inferOwnerAgentTypeFromRegisteredAgentTypes(folderAgentTypes);
  }

  return undefined;
}

export function resolveStableReviewerAgentType(
  ownerAgentType: AgentType | undefined,
  fallbackReviewerAgentType?: string | null,
): AgentType | null {
  const persistedReviewerAgentType = normalizeStoredAgentType(
    fallbackReviewerAgentType,
  );
  if (persistedReviewerAgentType) {
    return persistedReviewerAgentType;
  }

  if (ownerAgentType) {
    return REVIEWER_AGENT_TYPE !== ownerAgentType
      ? REVIEWER_AGENT_TYPE
      : ownerAgentType;
  }
  return null;
}

export function resolveStableRoomRoleAgentType(
  database: Database,
  input: {
    chatJid: string;
    groupFolder: string;
    role: PairedRoomRole;
  },
): AgentType | null | undefined {
  if (input.role === 'owner') {
    return resolveStablePairedTaskOwnerAgentType(database, {
      chat_jid: input.chatJid,
      group_folder: input.groupFolder,
      owner_agent_type: null,
    });
  }

  if (input.role === 'reviewer') {
    const ownerAgentType = resolveStablePairedTaskOwnerAgentType(database, {
      chat_jid: input.chatJid,
      group_folder: input.groupFolder,
      owner_agent_type: null,
    });
    return resolveStableReviewerAgentType(ownerAgentType, null);
  }

  return ARBITER_AGENT_TYPE ?? null;
}
