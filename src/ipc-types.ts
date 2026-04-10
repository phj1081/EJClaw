import type { AvailableGroup } from './agent-runner.js';
import type { AssignRoomInput } from './db.js';
import type { AgentType, RegisteredGroup, RoomMode } from './types.js';

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    senderRole?: string,
    runId?: string,
  ) => Promise<void>;
  nudgeScheduler?: () => void;
  roomBindings: () => Record<string, RegisteredGroup>;
  assignRoom: (jid: string, room: AssignRoomInput) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
  ) => void;
}

export interface IpcMessagePayload {
  type?: string;
  chatJid?: string;
  text?: string;
  senderRole?: string;
  runId?: string;
}

export interface IpcMessageForwardResult {
  outcome: 'ignored' | 'sent' | 'blocked';
  chatJid?: string;
  targetGroup?: string | null;
  isMainOverride?: boolean;
  senderRole?: string | null;
}

export interface TaskIpcPayload {
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
  jid?: string;
  name?: string;
  folder?: string;
  room_mode?: RoomMode;
  owner_agent_type?: AgentType;
  isMain?: boolean;
  workDir?: string;
  scopeKind?: string;
  scopeKey?: string;
  content?: string;
  keywords?: string[];
  memory_kind?: string | null;
  source_kind?: string;
  source_ref?: string | null;
  requestId?: string;
  action?: string;
  tail_lines?: number;
  profile?: string;
  expected_snapshot_id?: string;
}
