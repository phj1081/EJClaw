import { loadConfig } from './config/load-config.js';
import type { MoaConfig } from './moa.js';
import type { RoleModelConfig } from './config/schema.js';

export type { AppConfig, RoleModelConfig } from './config/schema.js';
export { loadConfig } from './config/load-config.js';

const CONFIG = loadConfig();

export const ASSISTANT_NAME = CONFIG.assistant.name;
export const ASSISTANT_HAS_OWN_NUMBER = CONFIG.assistant.hasOwnNumber;
export const SERVICE_ID = CONFIG.service.id;
export const CLAUDE_SERVICE_ID = CONFIG.service.claudeId;
export const CODEX_MAIN_SERVICE_ID = CONFIG.service.codexMainId;
export const CODEX_REVIEW_SERVICE_ID = CONFIG.service.codexReviewId;

export function normalizeServiceId(serviceId: string): string {
  if (serviceId === 'codex') {
    return CODEX_MAIN_SERVICE_ID;
  }
  return serviceId;
}

export const SERVICE_SESSION_SCOPE = normalizeServiceId(SERVICE_ID);
export const CURRENT_RUNTIME_AGENT_TYPE =
  SERVICE_SESSION_SCOPE === CLAUDE_SERVICE_ID ? 'claude-code' : 'codex';

export function isClaudeService(serviceId: string = SERVICE_ID): boolean {
  return normalizeServiceId(serviceId) === CLAUDE_SERVICE_ID;
}

export function isCodexMainService(serviceId: string = SERVICE_ID): boolean {
  return normalizeServiceId(serviceId) === CODEX_MAIN_SERVICE_ID;
}

export function isReviewService(serviceId: string = SERVICE_ID): boolean {
  return normalizeServiceId(serviceId) === CODEX_REVIEW_SERVICE_ID;
}
export const POLL_INTERVAL = CONFIG.runtime.pollInterval;
export const SCHEDULER_POLL_INTERVAL = CONFIG.runtime.schedulerPollInterval;

/** Minimum time (ms) a failover lease stays active before Claude can reclaim it. */
export const FAILOVER_MIN_DURATION_MS = CONFIG.runtime.failoverMinDurationMs;

export const SENDER_ALLOWLIST_PATH = CONFIG.paths.senderAllowlistPath;
export const STORE_DIR = CONFIG.paths.storeDir;
export const GROUPS_DIR = CONFIG.paths.groupsDir;
export const DATA_DIR = CONFIG.paths.dataDir;
export const CACHE_DIR = CONFIG.paths.cacheDir;

export const AGENT_TIMEOUT = CONFIG.runtime.agentTimeout;
export const AGENT_MAX_OUTPUT_SIZE = CONFIG.runtime.agentMaxOutputSize;
export const IPC_POLL_INTERVAL = CONFIG.runtime.ipcPollInterval;
export const IDLE_TIMEOUT = CONFIG.runtime.idleTimeout;
export const MAX_CONCURRENT_AGENTS = CONFIG.runtime.maxConcurrentAgents;
export const RECOVERY_CONCURRENT_AGENTS =
  CONFIG.runtime.recoveryConcurrentAgents;
export const LOG_LEVEL = CONFIG.logging.level;
export const IS_TEST_ENV = CONFIG.logging.isTestEnv;

// ── Paired review ─────────────────────────────────────────────────

/** Owner agent type. Default: codex. Set OWNER_AGENT_TYPE=claude-code to use Claude as owner. */
export const OWNER_AGENT_TYPE = CONFIG.paired.ownerAgentType;

/** Reviewer agent type. Default: claude-code. Set REVIEWER_AGENT_TYPE=codex to use Codex as reviewer. */
export const REVIEWER_AGENT_TYPE = CONFIG.paired.reviewerAgentType;

/** Service ID for the reviewer based on agent type. */
export const REVIEWER_SERVICE_ID_FOR_TYPE =
  CONFIG.paired.reviewerServiceIdForType;

/** Arbiter agent type. Disabled by default. Set ARBITER_AGENT_TYPE=codex or claude-code to enable. */
export const ARBITER_AGENT_TYPE = CONFIG.paired.arbiterAgentType;

/** Service ID for the arbiter. Defaults to codex-review for internal routing when arbiter is enabled. */
export const ARBITER_SERVICE_ID = CONFIG.paired.arbiterServiceId;

/** Whether to re-inject the previous task's latest owner final into a superseding task. Default: false. */
export const PAIRED_CARRY_FORWARD_LATEST_OWNER_FINAL =
  CONFIG.paired.carryForwardLatestOwnerFinal;

/** Whether unsafe-host Claude reviewers must always start on a fresh SDK session. Default: false. */
export const PAIRED_FORCE_FRESH_CLAUDE_REVIEWER_SESSION =
  CONFIG.paired.forceFreshClaudeReviewerSessionInUnsafeHostMode;

export function shouldForceFreshClaudeReviewerSessionInUnsafeHostMode(): boolean {
  return PAIRED_FORCE_FRESH_CLAUDE_REVIEWER_SESSION;
}

/** Language for agent responses. When set, a language instruction is appended to all paired room prompts. */
export const AGENT_LANGUAGE = CONFIG.paired.agentLanguage;

/** Number of consecutive owner↔reviewer round trips before arbiter is auto-requested. */
export const ARBITER_DEADLOCK_THRESHOLD =
  CONFIG.paired.arbiterDeadlockThreshold;

export function isArbiterEnabled(): boolean {
  return ARBITER_AGENT_TYPE !== undefined;
}

// ── Per-role model configuration ─────────────────────────────────

export const OWNER_MODEL_CONFIG = CONFIG.models.owner;
export const REVIEWER_MODEL_CONFIG = CONFIG.models.reviewer;
export const ARBITER_MODEL_CONFIG = CONFIG.models.arbiter;
export const DEFAULT_CLAUDE_MODEL = CONFIG.providers.claudeDefaultModel;
export const DEFAULT_CODEX_MODEL = CONFIG.providers.codexDefaultModel;

export function getRoleModelConfig(
  role: 'owner' | 'reviewer' | 'arbiter',
): RoleModelConfig {
  switch (role) {
    case 'owner':
      return OWNER_MODEL_CONFIG;
    case 'reviewer':
      return REVIEWER_MODEL_CONFIG;
    case 'arbiter':
      return ARBITER_MODEL_CONFIG;
  }
}

// ── Mixture of Agents (MoA) ──────────────────────────────────────

export function getMoaConfig(): MoaConfig {
  return CONFIG.moa;
}

export const PAIRED_MAX_ROUND_TRIPS = CONFIG.paired.maxRoundTrips;

export const RECOVERY_STAGGER_MS = CONFIG.runtime.recoveryStaggerMs;
export const RECOVERY_DURATION_MS = CONFIG.runtime.recoveryDurationMs;

export const TRIGGER_PATTERN = CONFIG.assistant.triggerPattern;

// Status dashboard: Discord channel ID for live agent status updates
export const STATUS_CHANNEL_ID = CONFIG.status.channelId;
export const STATUS_UPDATE_INTERVAL = CONFIG.status.updateInterval;
export const USAGE_UPDATE_INTERVAL = CONFIG.status.usageUpdateInterval;
export const STATUS_SHOW_ROOMS = CONFIG.status.showRooms;
export const STATUS_SHOW_ROOM_DETAILS = CONFIG.status.showRoomDetails;
export const USAGE_DASHBOARD_ENABLED = CONFIG.status.usageDashboardEnabled;
export const CODEX_WARMUP_CONFIG = CONFIG.codexWarmup;
export const WEB_DASHBOARD = CONFIG.webDashboard;

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE = CONFIG.status.timezone;

const SESSION_COMMAND_ALLOWED_SENDERS = CONFIG.sessionCommands.allowedSenders;

export function isSessionCommandSenderAllowed(sender: string): boolean {
  return SESSION_COMMAND_ALLOWED_SENDERS.has(sender);
}

// Delta handoff: cross-provider session continuity with probe + fallback
export const DELTA_HANDOFF_ENABLED = CONFIG.deltaHandoff.enabled;
export const DELTA_HANDOFF_CANARY_GROUPS = CONFIG.deltaHandoff.canaryGroups;

export function isDeltaHandoffEnabledForGroup(groupFolder: string): boolean {
  if (!DELTA_HANDOFF_ENABLED) return false;
  // If canary groups are specified, only enable for those groups
  if (DELTA_HANDOFF_CANARY_GROUPS.size > 0) {
    return DELTA_HANDOFF_CANARY_GROUPS.has(groupFolder);
  }
  return true;
}
