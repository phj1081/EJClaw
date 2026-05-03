import type { VisibleVerdict } from './paired-verdict.js';

export interface AgentConfig {
  timeout?: number; // Default: 300000 (5 minutes)
  // Per-group model/effort overrides (take precedence over global env vars)
  codexModel?: string;
  codexEffort?: string;
  codexGoals?: boolean;
  claudeModel?: string;
  claudeEffort?: string;
  claudeThinking?: 'adaptive' | 'enabled' | 'disabled';
  claudeThinkingBudget?: number;
}

export type AgentType = 'claude-code' | 'codex';
export type RoomMode = 'single' | 'tribunal';

/** Phase of agent output as emitted by the runner. */
export type AgentOutputPhase =
  | 'progress'
  | 'final'
  | 'tool-activity'
  | 'intermediate';

/** Phase as visible in the UI (mapped from AgentOutputPhase). */
export type VisiblePhase = 'silent' | 'progress' | 'final';

export type AgentVisibility = 'public' | 'silent';

export interface OutboundAttachment {
  path: string;
  name?: string;
  mime?: string;
}

export interface SendMessageOptions {
  attachments?: OutboundAttachment[];
  /**
   * Extra realpath roots that are valid for this delivery attempt. Runtime
   * callers can pass the active project/workspace directory without widening
   * the global Discord attachment allowlist.
   */
  attachmentBaseDirs?: string[];
}

export interface SendMessageResult {
  primaryMessageId: string | null;
  messageIds: string[];
  visible: boolean;
}

export interface DeleteRecentMessagesByContentOptions {
  contentIncludes: string;
  exceptMessageId?: string | null;
  limit?: number;
}

export type PairedRoomRole = 'owner' | 'reviewer' | 'arbiter';

export type PairedTaskStatus =
  | 'active'
  | 'review_ready'
  | 'in_review'
  | 'merge_ready'
  | 'completed'
  | 'arbiter_requested'
  | 'in_arbitration';

export type PairedTurnReservationIntentKind =
  | 'owner-turn'
  | 'reviewer-turn'
  | 'arbiter-turn'
  | 'owner-follow-up'
  | 'finalize-owner-turn';

export type ArbiterVerdict = 'proceed' | 'revise' | 'reset' | 'escalate';

export type PairedWorkspaceRole = 'owner' | 'reviewer';

export type PairedWorkspaceStatus = 'ready' | 'stale';

export interface RoomRoleContext {
  serviceId: string;
  role: PairedRoomRole;
  ownerServiceId: string;
  reviewerServiceId: string;
  ownerAgentType?: AgentType;
  reviewerAgentType?: AgentType | null;
  failoverOwner: boolean;
  arbiterServiceId?: string;
  arbiterAgentType?: AgentType | null;
}

export interface PairedProject {
  chat_jid: string;
  group_folder: string;
  canonical_work_dir: string;
  created_at: string;
  updated_at: string;
}

export interface PairedTask {
  id: string;
  chat_jid: string;
  group_folder: string;
  owner_service_id: string;
  reviewer_service_id: string;
  owner_agent_type?: AgentType | null;
  reviewer_agent_type?: AgentType | null;
  arbiter_agent_type?: AgentType | null;
  title: string | null;
  source_ref: string | null;
  plan_notes: string | null;
  review_requested_at: string | null;
  round_trip_count: number;
  owner_failure_count?: number | null;
  owner_step_done_streak?: number | null;
  finalize_step_done_count?: number | null;
  task_done_then_user_reopen_count?: number | null;
  empty_step_done_streak?: number | null;
  status: PairedTaskStatus;
  arbiter_verdict: string | null;
  arbiter_requested_at: string | null;
  completion_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PairedTurnOutput {
  id: number;
  task_id: string;
  turn_number: number;
  role: PairedRoomRole;
  output_text: string;
  verdict?: VisibleVerdict | null;
  created_at: string;
}

export interface PairedWorkspace {
  id: string;
  task_id: string;
  role: PairedWorkspaceRole;
  workspace_dir: string;
  snapshot_source_dir: string | null;
  snapshot_ref: string | null;
  status: PairedWorkspaceStatus;
  snapshot_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentResponsePolicy = 'normal' | 'silent-unless-addressed';

export type StructuredAgentOutput =
  | {
      visibility: 'public';
      text: string;
      attachments?: OutboundAttachment[];
    }
  | {
      visibility: 'silent';
    };

export function normalizeAgentOutputPhase(
  phase?: AgentOutputPhase,
): AgentOutputPhase {
  return phase ?? 'final';
}

export function toVisiblePhase(phase: AgentOutputPhase): VisiblePhase {
  switch (phase) {
    case 'intermediate':
    case 'tool-activity':
      return 'silent';
    case 'progress':
      return 'progress';
    case 'final':
      return 'final';
    default: {
      const exhaustive: never = phase;
      throw new Error(`Unknown agent output phase: ${exhaustive}`);
    }
  }
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger?: string;
  added_at: string;
  agentConfig?: AgentConfig;
  requiresTrigger?: boolean; // Whether non-paired messages must match the room trigger
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  agentType?: AgentType;
  workDir?: string; // Working directory for the agent (defaults to group folder)
}

export type MessageSourceKind =
  | 'human'
  | 'bot'
  | 'trusted_external_bot'
  | 'ipc_injected_human'
  | 'ipc_injected_bot';

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  seq?: number;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  message_source_kind?: MessageSourceKind;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  agent_type: AgentType | null;
  ci_provider?: 'github' | null;
  ci_metadata?: string | null;
  max_duration_ms?: number | null;
  status_message_id: string | null;
  status_started_at: string | null;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  suspended_until?: string | null;
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface ChannelMeta {
  name: string;
  position: number;
  category: string;
  categoryPosition: number;
}

export interface ChannelOutboundAuditMeta {
  channelName: string;
  botUserId: string | null;
  botUsername: string | null;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult | void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  // Optional: whether a stored inbound message was authored by this channel's own bot/user.
  isOwnMessage?(msg: NewMessage): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: edit/delete messages (used by status dashboard and tracked progress cleanup).
  editMessage?(jid: string, messageId: string, text: string): Promise<void>;
  deleteMessage?(jid: string, messageId: string): Promise<void>;
  deleteRecentMessagesByContent?(
    jid: string,
    options: DeleteRecentMessagesByContentOptions,
  ): Promise<number>;
  sendAndTrack?(jid: string, text: string): Promise<string | null>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: get channel metadata (position, category) for ordering.
  getChannelMeta?(jids: string[]): Promise<Map<string, ChannelMeta>>;
  // Optional: delete all messages in a channel (used for dashboard cleanup).
  purgeChannel?(jid: string): Promise<number>;
  // Optional: expose runtime sender identity for outbound audit logs.
  getOutboundAuditMeta?(): ChannelOutboundAuditMeta;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
