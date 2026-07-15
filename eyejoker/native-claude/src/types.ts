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
  fallbackModel?: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode: PermissionMode;
  requireMention: boolean;
  instructions?: string;
  mixedAgents?: boolean;
}

export interface SessionBranch {
  sessionId: string;
  conversationKey: string;
  parentSessionId: string | null;
  label: string | null;
  status: "active" | "archived";
  createdAt: string;
}

export interface RewindOperation {
  id: string;
  conversationKey: string;
  sessionId: string;
  checkpoint: string;
  preview: {
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  };
  status: "previewed" | "applied";
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSettings {
  model: string | null;
  permissionMode: PermissionMode | null;
  effort: RouteConfig["effort"] | null;
  forkNext: boolean;
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
  rawPrompt?: boolean;
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

export interface OutboundFile {
  path: string;
  name: string;
}

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
  rawPrompt: boolean;
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
  deliveryChunks: string[] | null;
  deliveryFiles: OutboundFile[];
  deliveryCursor: number;
  deliveryMessageIds: string[];
  progressMessageId: string | null;
  progressText: string | null;
  mainModel: string | null;
  subagentModels: string[];
  createdAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  completedAt: string | null;
}

export interface InteractiveQuestion {
  question: string;
  choices: string[];
  requestId?: string;
  kind?: "question" | "permission";
}

export interface InteractionRecord {
  id: string;
  jobId: string;
  conversationKey: string;
  requestKey: string;
  question: InteractiveQuestion;
  discordMessageId: string | null;
  answer: string | null;
  status: "pending" | "answered" | "orphaned";
  createdAt: string;
  updatedAt: string;
}

export type SteeringInputState = "pending" | "accepted" | "edited" | "deleted";

export interface SteeringInputRecord {
  messageId: string;
  jobId: string;
  conversationKey: string;
  content: string;
  sdkMessageId: string;
  state: SteeringInputState;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
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
  forkSession?: boolean;
  onSpawn?: (pid: number) => void;
  onHeartbeat?: () => void;
  onCheckpoint?: (userMessageId: string) => void;
  onQuestion?: (question: InteractiveQuestion) => Promise<string>;
  onProgress?: (
    event: import("./stream-progress").ProgressEvent,
    aggregator: import("./stream-progress").StreamProgressAggregator,
  ) => void;
}

export type ClaudeExecutor = (request: ExecutionRequest) => Promise<ClaudeExecution>;

export type FinalHook = (job: JobRecord, execution: ClaudeExecution) => Promise<void>;
export type StartHook = (job: JobRecord) => Promise<void>;
export type QuestionHook = (job: JobRecord, question: InteractiveQuestion) => Promise<string>;
export type ProgressHook = (
  job: JobRecord,
  event: import("./stream-progress").ProgressEvent,
  aggregator: import("./stream-progress").StreamProgressAggregator,
) => Promise<void> | void;
