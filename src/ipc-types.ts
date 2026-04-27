import type { AvailableGroup } from './agent-runner.js';
import type { AssignRoomInput } from './db.js';
import type {
  AgentType,
  MessageSourceKind,
  OutboundAttachment,
  PairedTask,
  RegisteredGroup,
  RoomMode,
} from './types.js';

export interface InjectInboundMessagePayload {
  chatJid: string;
  text: string;
  sender?: string;
  senderName?: string;
  messageId?: string;
  timestamp?: string;
  treatAsHuman: boolean;
  sourceKind?: MessageSourceKind;
}

export interface RoomRuntimeReport {
  chatJid: string;
  groupFolder: string;
  room: RegisteredGroup | null;
  queue: {
    status: 'processing' | 'waiting' | 'inactive';
    runPhase: string;
    elapsedMs: number | null;
    pendingMessages: boolean;
    pendingTasks: number;
    currentRunId: string | null;
    runningTaskId: string | null;
    processName: string | null;
    ipcDir: string | null;
    retryCount: number;
    retryScheduledAt: number | null;
    waiting: boolean;
  };
  latestOpenTask: Pick<
    PairedTask,
    | 'id'
    | 'status'
    | 'title'
    | 'round_trip_count'
    | 'updated_at'
    | 'owner_agent_type'
    | 'reviewer_agent_type'
    | 'arbiter_agent_type'
  > | null;
  recentMessages: Array<{
    id: string;
    seq?: number;
    timestamp: string;
    sender: string;
    senderName: string;
    isFromMe: boolean;
    isBotMessage: boolean;
    sourceKind: MessageSourceKind;
    contentPreview: string;
  }>;
}

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    senderRole?: string,
    runId?: string,
    attachments?: OutboundAttachment[],
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
  injectInboundMessage?: (
    payload: InjectInboundMessagePayload,
  ) => Promise<void>;
  getRoomRuntimeReport?: (args: {
    chatJid: string;
    sourceGroup: string;
    isMain: boolean;
  }) => RoomRuntimeReport;
}

export interface IpcMessagePayload {
  type?: string;
  chatJid?: string;
  text?: string;
  senderRole?: string;
  runId?: string;
  sender?: string;
  senderName?: string;
  messageId?: string;
  timestamp?: string;
  treatAsHuman?: boolean;
  sourceKind?: MessageSourceKind;
  attachments?: OutboundAttachment[];
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
  reviewer_agent_type?: AgentType;
  arbiter_agent_type?: AgentType | null;
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
