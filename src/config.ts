import os from 'os';
import path from 'path';

import type { AgentType } from './types.js';
import { getEnv } from './env.js';

export const ASSISTANT_NAME = getEnv('ASSISTANT_NAME') || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  getEnv('ASSISTANT_HAS_OWN_NUMBER') === 'true';
const ASSISTANT_SLUG = ASSISTANT_NAME.trim().toLowerCase();
export const SERVICE_ID = getEnv('SERVICE_ID') || ASSISTANT_SLUG;
export const CLAUDE_SERVICE_ID = getEnv('CLAUDE_SERVICE_ID') || 'claude';
export const CODEX_MAIN_SERVICE_ID =
  getEnv('CODEX_MAIN_SERVICE_ID') || 'codex-main';
export const CODEX_REVIEW_SERVICE_ID =
  getEnv('CODEX_REVIEW_SERVICE_ID') || 'codex-review';

export function normalizeServiceId(serviceId: string): string {
  if (serviceId === 'codex') {
    return CODEX_MAIN_SERVICE_ID;
  }
  return serviceId;
}

export const SERVICE_SESSION_SCOPE = normalizeServiceId(SERVICE_ID);

export function isClaudeService(serviceId: string = SERVICE_ID): boolean {
  return normalizeServiceId(serviceId) === CLAUDE_SERVICE_ID;
}

export function isCodexMainService(serviceId: string = SERVICE_ID): boolean {
  return normalizeServiceId(serviceId) === CODEX_MAIN_SERVICE_ID;
}

export function isReviewService(serviceId: string = SERVICE_ID): boolean {
  return normalizeServiceId(serviceId) === CODEX_REVIEW_SERVICE_ID;
}
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

/** Minimum time (ms) a failover lease stays active before Claude can reclaim it. */
export const FAILOVER_MIN_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours

const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'ejclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(
  process.env.EJCLAW_STORE_DIR || path.join(PROJECT_ROOT, 'store'),
);
export const GROUPS_DIR = path.resolve(
  process.env.EJCLAW_GROUPS_DIR || path.join(PROJECT_ROOT, 'groups'),
);
export const DATA_DIR = path.resolve(
  process.env.EJCLAW_DATA_DIR || path.join(PROJECT_ROOT, 'data'),
);
// Shared cache directory (same across both services for dedup)
export const CACHE_DIR = path.join(PROJECT_ROOT, 'cache');

export const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || '1800000',
  10,
);
export const AGENT_MAX_OUTPUT_SIZE = parseInt(
  process.env.AGENT_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep agent alive after last result
export const MAX_CONCURRENT_AGENTS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_AGENTS || '5', 10) || 5,
);
export const RECOVERY_CONCURRENT_AGENTS = parseInt(
  getEnv('RECOVERY_CONCURRENT_AGENTS') || '3',
  10,
);

// ── Paired review ─────────────────────────────────────────────────

/** Owner agent type. Default: codex. Set OWNER_AGENT_TYPE=claude-code to use Claude as owner. */
const rawOwnerAgentType = getEnv('OWNER_AGENT_TYPE');
export const OWNER_AGENT_TYPE: AgentType =
  rawOwnerAgentType === 'codex' || rawOwnerAgentType === 'claude-code'
    ? rawOwnerAgentType
    : 'codex';

/** Reviewer agent type. Default: claude-code. Set REVIEWER_AGENT_TYPE=codex to use Codex as reviewer. */
const rawReviewerAgentType = getEnv('REVIEWER_AGENT_TYPE');
export const REVIEWER_AGENT_TYPE: AgentType =
  rawReviewerAgentType === 'codex' || rawReviewerAgentType === 'claude-code'
    ? rawReviewerAgentType
    : 'claude-code';

/** Service ID for the reviewer based on agent type. */
export const REVIEWER_SERVICE_ID_FOR_TYPE =
  REVIEWER_AGENT_TYPE === 'claude-code'
    ? CLAUDE_SERVICE_ID
    : CODEX_REVIEW_SERVICE_ID;

/** Arbiter agent type. Disabled by default. Set ARBITER_AGENT_TYPE=codex or claude-code to enable. */
const rawArbiterAgentType = getEnv('ARBITER_AGENT_TYPE');
export const ARBITER_AGENT_TYPE: AgentType | undefined =
  rawArbiterAgentType === 'codex' || rawArbiterAgentType === 'claude-code'
    ? rawArbiterAgentType
    : undefined;

/** Service ID for the arbiter. Defaults to codex-review for internal routing when arbiter is enabled. */
export const ARBITER_SERVICE_ID = ARBITER_AGENT_TYPE
  ? getEnv('ARBITER_SERVICE_ID') || CODEX_REVIEW_SERVICE_ID
  : null;

/** Language for agent responses. When set, a language instruction is appended to all paired room prompts. */
export const AGENT_LANGUAGE = getEnv('AGENT_LANGUAGE') || '';

/** Number of consecutive owner↔reviewer round trips before arbiter is auto-requested. */
export const ARBITER_DEADLOCK_THRESHOLD = parseInt(
  getEnv('ARBITER_DEADLOCK_THRESHOLD') || '2',
  10,
);

export function isArbiterEnabled(): boolean {
  return ARBITER_AGENT_TYPE !== undefined;
}

// ── Per-role model configuration ─────────────────────────────────

export interface RoleModelConfig {
  /** Model name override (e.g. 'claude-opus-4-6', 'gpt-5.4'). */
  model?: string;
  /** Effort level override. */
  effort?: string;
  /** Whether to fall back to codex when primary provider fails. Default: true. */
  fallbackEnabled: boolean;
}

function buildRoleModelConfig(envPrefix: string): RoleModelConfig {
  return {
    model: getEnv(`${envPrefix}_MODEL`) || undefined,
    effort: getEnv(`${envPrefix}_EFFORT`) || undefined,
    fallbackEnabled: getEnv(`${envPrefix}_FALLBACK_ENABLED`) !== 'false',
  };
}

export const OWNER_MODEL_CONFIG = buildRoleModelConfig('OWNER');
export const REVIEWER_MODEL_CONFIG = buildRoleModelConfig('REVIEWER');
export const ARBITER_MODEL_CONFIG = buildRoleModelConfig('ARBITER');

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

import type { MoaConfig, MoaModelConfig } from './moa.js';

/**
 * Parse MOA reference models from env.
 * Format: MOA_REF_MODELS=kimi,glm (comma-separated names)
 * Each model: MOA_{NAME}_MODEL, MOA_{NAME}_BASE_URL, MOA_{NAME}_API_KEY
 */
function parseMoaReferenceModels(): MoaModelConfig[] {
  const names = (getEnv('MOA_REF_MODELS') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return names
    .map((name) => {
      const prefix = `MOA_${name.toUpperCase()}`;
      const model = getEnv(`${prefix}_MODEL`) || '';
      const baseUrl = getEnv(`${prefix}_BASE_URL`) || '';
      const apiKey = getEnv(`${prefix}_API_KEY`) || '';
      if (!model || !baseUrl || !apiKey) return null;
      const rawFormat = getEnv(`${prefix}_API_FORMAT`) || '';
      const apiFormat: 'openai' | 'anthropic' =
        rawFormat === 'anthropic' ? 'anthropic' : 'openai';
      return { name, model, baseUrl, apiKey, apiFormat };
    })
    .filter((m): m is MoaModelConfig => m !== null);
}

export function getMoaConfig(): MoaConfig {
  const referenceModels = parseMoaReferenceModels();
  return {
    enabled: getEnv('MOA_ENABLED') === 'true' && referenceModels.length > 0,
    referenceModels,
  };
}

// Max owner↔reviewer round trips per task. 0 = unlimited.
const rawMaxRoundTrips = getEnv('PAIRED_MAX_ROUND_TRIPS') || '1000';
export const PAIRED_MAX_ROUND_TRIPS =
  rawMaxRoundTrips === '0' ? Infinity : parseInt(rawMaxRoundTrips, 10) || 1000;

export const RECOVERY_STAGGER_MS = parseInt(
  getEnv('RECOVERY_STAGGER_MS') || '2000',
  10,
);
export const RECOVERY_DURATION_MS = parseInt(
  getEnv('RECOVERY_DURATION_MS') || '60000',
  10,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Status dashboard: Discord channel ID for live agent status updates
export const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID || '';
export const STATUS_UPDATE_INTERVAL = 10000; // 10s
export const USAGE_UPDATE_INTERVAL = 300000; // 5 minutes
export const STATUS_SHOW_ROOMS =
  (getEnv('STATUS_SHOW_ROOMS') || 'true') !== 'false';
export const STATUS_SHOW_ROOM_DETAILS =
  (getEnv('STATUS_SHOW_ROOM_DETAILS') || 'true') !== 'false';
export const USAGE_DASHBOARD_ENABLED = getEnv('USAGE_DASHBOARD') === 'true';

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

const rawSessionCommandAllowedSenders =
  getEnv('SESSION_COMMAND_ALLOWED_SENDERS') ||
  getEnv('SESSION_COMMAND_USER_IDS') ||
  '';

const SESSION_COMMAND_ALLOWED_SENDERS = new Set(
  rawSessionCommandAllowedSenders
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

export function isSessionCommandSenderAllowed(sender: string): boolean {
  return SESSION_COMMAND_ALLOWED_SENDERS.has(sender);
}

// Delta handoff: cross-provider session continuity with probe + fallback
export const DELTA_HANDOFF_ENABLED = getEnv('DELTA_HANDOFF_ENABLED') === 'true';

// Comma-separated list of group folders for canary testing
const rawDeltaHandoffCanaryGroups = getEnv('DELTA_HANDOFF_CANARY_GROUPS') || '';
export const DELTA_HANDOFF_CANARY_GROUPS = new Set(
  rawDeltaHandoffCanaryGroups
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
);

export function isDeltaHandoffEnabledForGroup(groupFolder: string): boolean {
  if (!DELTA_HANDOFF_ENABLED) return false;
  // If canary groups are specified, only enable for those groups
  if (DELTA_HANDOFF_CANARY_GROUPS.size > 0) {
    return DELTA_HANDOFF_CANARY_GROUPS.has(groupFolder);
  }
  return true;
}
