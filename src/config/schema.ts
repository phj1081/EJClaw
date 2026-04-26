import type { MoaConfig } from '../moa.js';
import type { AgentType } from '../types.js';

export interface RoleModelConfig {
  model?: string;
  effort?: string;
  fallbackEnabled: boolean;
}

export interface AppConfig {
  assistant: {
    name: string;
    hasOwnNumber: boolean;
    slug: string;
    triggerPattern: RegExp;
  };
  service: {
    id: string;
    sessionScope: string;
    claudeId: string;
    codexMainId: string;
    codexReviewId: string;
  };
  paths: {
    projectRoot: string;
    homeDir: string;
    senderAllowlistPath: string;
    storeDir: string;
    groupsDir: string;
    dataDir: string;
    cacheDir: string;
  };
  runtime: {
    pollInterval: number;
    schedulerPollInterval: number;
    failoverMinDurationMs: number;
    agentTimeout: number;
    agentMaxOutputSize: number;
    ipcPollInterval: number;
    idleTimeout: number;
    maxConcurrentAgents: number;
    recoveryConcurrentAgents: number;
    recoveryStaggerMs: number;
    recoveryDurationMs: number;
  };
  logging: {
    level: string;
    isTestEnv: boolean;
  };
  paired: {
    ownerAgentType: AgentType;
    reviewerAgentType: AgentType;
    reviewerServiceIdForType: string;
    arbiterAgentType?: AgentType;
    arbiterServiceId: string | null;
    carryForwardLatestOwnerFinal: boolean;
    forceFreshClaudeReviewerSessionInUnsafeHostMode: boolean;
    agentLanguage: string;
    arbiterDeadlockThreshold: number;
    maxRoundTrips: number;
  };
  models: {
    owner: RoleModelConfig;
    reviewer: RoleModelConfig;
    arbiter: RoleModelConfig;
  };
  providers: {
    claudeDefaultModel: string;
    codexDefaultModel: string;
  };
  moa: MoaConfig;
  status: {
    channelId: string;
    updateInterval: number;
    usageUpdateInterval: number;
    showRooms: boolean;
    showRoomDetails: boolean;
    usageDashboardEnabled: boolean;
    timezone: string;
  };
  webDashboard: {
    enabled: boolean;
    host: string;
    port: number;
    staticDir: string;
  };
  codexWarmup: {
    enabled: boolean;
    prompt: string;
    model: string;
    intervalMs: number;
    minIntervalMs: number;
    staggerMs: number;
    maxUsagePct: number;
    maxD7UsagePct: number;
    commandTimeoutMs: number;
    failureCooldownMs: number;
    maxConsecutiveFailures: number;
  };
  sessionCommands: {
    allowedSenders: Set<string>;
  };
  deltaHandoff: {
    enabled: boolean;
    canaryGroups: Set<string>;
  };
}
