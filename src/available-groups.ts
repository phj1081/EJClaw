import type { AvailableGroup } from './agent-runner.js';
import { getAllChats } from './db.js';
import type { RegisteredGroup } from './types.js';

export function listAvailableGroups(
  roomBindings: Record<string, RegisteredGroup>,
): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(roomBindings));

  return chats
    .filter((chat) => chat.jid !== '__group_sync__' && chat.is_group)
    .map((chat) => ({
      jid: chat.jid,
      name: chat.name,
      lastActivity: chat.last_message_time,
      isRegistered: registeredJids.has(chat.jid),
    }));
}
