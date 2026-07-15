export type PermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "manual"
  | "dontAsk"
  | "plan";

export interface RouteConfig {
  id: string;
  discordChannelId: string;
  cwd: string;
  lockKey?: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode: PermissionMode;
  requireMention: boolean;
  instructions?: string;
  mixedAgents?: boolean;
}

export interface RuntimeConfig {
  ownerId: string;
  allowedUserIds: string[];
  maxConcurrent: number;
  maxAttempts: number;
  jobTimeoutSeconds: number;
  routes: RouteConfig[];
}

export interface EnqueueInput {
  routeId: string;
  lockKey?: string;
  conversationKey: string;
  channelId: string;
  threadId: string | null;
  messageId: string;
  authorId: string;
  prompt: string;
  attachmentPaths: string[];
}

export type JobStatus =
  | "queued"
  | "running"
  | "delivering"
  | "completed"
  | "failed"
  | "cancelled";

export type FinalStatus = "completed" | "failed";

export interface JobRecord {
  id: string;
  routeId: string;
  lockKey: string;
  conversationKey: string;
  channelId: string;
  threadId: string | null;
  messageId: string;
  authorId: string;
  prompt: string;
  attachmentPaths: string[];
  status: JobStatus;
  sessionId: string;
  attempts: number;
  startedBefore: boolean;
  recoveryReason: string | null;
  pid: number | null;
  result: string | null;
  error: string | null;
  finalStatus: FinalStatus | null;
  deliveryAttempts: number;
  deliveryAfter: string | null;
  deliveryError: string | null;
  progressMessageId: string | null;
  progressText: string | null;
  mainModel: string | null;
  subagentModels: string[];
  createdAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  completedAt: string | null;
}

export interface ClaudeExecution {
  ok: boolean;
  result: string;
  sessionId: string;
  stderr: string;
  exitCode: number;
  mainModel?: string;
  subagentModels?: string[];
}

export interface ExecutionRequest {
  job: JobRecord;
  route: RouteConfig;
  prompt: string;
  sessionId: string;
  resume: boolean;
  onSpawn?: (pid: number) => void;
  onHeartbeat?: () => void;
  onProgress?: (
    event: import("./stream-progress").ProgressEvent,
    aggregator: import("./stream-progress").StreamProgressAggregator,
  ) => void;
}

export type ClaudeExecutor = (request: ExecutionRequest) => Promise<ClaudeExecution>;

export type FinalHook = (job: JobRecord, execution: ClaudeExecution) => Promise<void>;
export type StartHook = (job: JobRecord) => Promise<void>;
export type ProgressHook = (
  job: JobRecord,
  event: import("./stream-progress").ProgressEvent,
  aggregator: import("./stream-progress").StreamProgressAggregator,
) => Promise<void> | void;
