import type { RoomRoleContext } from './room-role-context.js';

export interface RunnerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  roomRoleContext?: RoomRoleContext;
}
