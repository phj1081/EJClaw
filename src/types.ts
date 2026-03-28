export interface AgentConfig {
  timeout?: number; // Default: 300000 (5 minutes)
  // Per-group model/effort overrides (take precedence over global env vars)
  codexModel?: string;
  codexEffort?: string;
  claudeModel?: string;
  claudeEffort?: string;
  claudeThinking?: 'adaptive' | 'enabled' | 'disabled';
  claudeThinkingBudget?: number;
}

export type AgentType = 'claude-code' | 'codex';

/** Phase of agent output as emitted by the runner. */
export type AgentOutputPhase =
  | 'progress'
  | 'final'
  | 'tool-activity'
  | 'intermediate';

/** Phase as visible in the UI (mapped from AgentOutputPhase). */
export type VisiblePhase = 'silent' | 'progress' | 'final';

export type AgentVisibility = 'public' | 'silent';

export type PairedRoomRole = 'owner' | 'reviewer';

export type PairedWorkspaceTopology = 'shadow-snapshot' | 'reviewer-cow';

export type PairedTaskStatus =
  | 'active'
  | 'draft'
  | 'plan_review_pending'
  | 'review_pending'
  | 'review_ready'
  | 'in_review'
  | 'changes_requested'
  | 'merge_ready'
  | 'merged'
  | 'discarded'
  | 'failed';

export type PairedTaskPolicy = 'autonomous' | 'user_signoff_required';

export type PairedRiskLevel = 'low' | 'high';

export type PairedPlanStatus =
  | 'not_requested'
  | 'pending'
  | 'approved'
  | 'changes_requested';

export type PairedExecutionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type PairedWorkspaceRole = 'owner' | 'reviewer';

export type PairedWorkspaceStatus =
  | 'provisioning'
  | 'ready'
  | 'stale'
  | 'failed'
  | 'archived';

export type PairedApprovalStatus = 'pending' | 'approved' | 'rejected';

export type PairedArtifactType =
  | 'comment'
  | 'report'
  | 'patch'
  | 'plan_brief'
  | 'acceptance_criteria'
  | 'risk_summary';

export type PairedEventActorRole = PairedRoomRole | 'system';

export type PairedEventType =
  | 'set_risk'
  | 'submit_plan'
  | 'approve_plan'
  | 'request_plan_changes'
  | 'request_review';

export interface RoomRoleContext {
  serviceId: string;
  role: PairedRoomRole;
  ownerServiceId: string;
  reviewerServiceId: string;
  failoverOwner: boolean;
}

export interface PairedProject {
  chat_jid: string;
  group_folder: string;
  canonical_work_dir: string;
  workspace_topology: PairedWorkspaceTopology;
  created_at: string;
  updated_at: string;
}

export interface PairedTask {
  id: string;
  chat_jid: string;
  group_folder: string;
  owner_service_id: string;
  reviewer_service_id: string;
  title: string | null;
  source_ref: string | null;
  task_policy: PairedTaskPolicy;
  risk_level: PairedRiskLevel;
  plan_status: PairedPlanStatus;
  review_requested_at: string | null;
  status: PairedTaskStatus;
  created_at: string;
  updated_at: string;
}

export interface PairedExecution {
  id: string;
  task_id: string;
  service_id: string;
  role: PairedWorkspaceRole;
  workspace_id: string | null;
  status: PairedExecutionStatus;
  summary: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface PairedWorkspace {
  id: string;
  task_id: string;
  role: PairedWorkspaceRole;
  workspace_dir: string;
  snapshot_source_dir: string | null;
  snapshot_source_fingerprint: string | null;
  status: PairedWorkspaceStatus;
  snapshot_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PairedApproval {
  id: number;
  task_id: string;
  service_id: string;
  role: PairedWorkspaceRole;
  status: PairedApprovalStatus;
  note: string | null;
  created_at: string;
}

export interface PairedArtifact {
  id: number;
  task_id: string;
  execution_id: string | null;
  service_id: string;
  artifact_type: PairedArtifactType;
  title: string | null;
  content: string | null;
  file_path: string | null;
  created_at: string;
}

export interface PairedEvent {
  id: number;
  task_id: string;
  event_type: PairedEventType;
  actor_role: PairedEventActorRole;
  source_service_id: string;
  source_fingerprint: string | null;
  dedupe_key: string;
  payload_json: string | null;
  created_at: string;
}

export type StructuredAgentOutput =
  | {
      visibility: 'public';
      text: string;
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
  trigger: string;
  added_at: string;
  agentConfig?: AgentConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  agentType?: AgentType;
  workDir?: string; // Working directory for the agent (defaults to group folder)
}

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

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  // Optional: whether a stored inbound message was authored by this channel's own bot/user.
  isOwnMessage?(msg: NewMessage): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: edit/delete messages (used by status dashboard).
  editMessage?(jid: string, messageId: string, text: string): Promise<void>;
  sendAndTrack?(jid: string, text: string): Promise<string | null>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: get channel metadata (position, category) for ordering.
  getChannelMeta?(jids: string[]): Promise<Map<string, ChannelMeta>>;
  // Optional: delete all messages in a channel (used for dashboard cleanup).
  purgeChannel?(jid: string): Promise<number>;
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
