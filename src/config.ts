import os from 'os';
import path from 'path';

import type { AgentType } from './types.js';
import { readEnvFile } from './env.js';

const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'SERVICE_ID',
  'SERVICE_AGENT_TYPE',
  'SESSION_COMMAND_ALLOWED_SENDERS',
  'SESSION_COMMAND_USER_IDS',
  'STATUS_SHOW_ROOMS',
  'USAGE_DASHBOARD',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
const ASSISTANT_SLUG = ASSISTANT_NAME.trim().toLowerCase();
const rawServiceAgentType =
  process.env.SERVICE_AGENT_TYPE || envConfig.SERVICE_AGENT_TYPE;
export const SERVICE_ID =
  process.env.SERVICE_ID || envConfig.SERVICE_ID || ASSISTANT_SLUG;
export const SERVICE_AGENT_TYPE: AgentType =
  rawServiceAgentType === 'codex' || rawServiceAgentType === 'claude-code'
    ? rawServiceAgentType
    : ASSISTANT_SLUG === 'codex'
      ? 'codex'
      : 'claude-code';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

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
  (process.env.STATUS_SHOW_ROOMS || envConfig.STATUS_SHOW_ROOMS || 'true') !==
  'false';
export const USAGE_DASHBOARD_ENABLED =
  (process.env.USAGE_DASHBOARD || envConfig.USAGE_DASHBOARD) === 'true';

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

const rawSessionCommandAllowedSenders =
  process.env.SESSION_COMMAND_ALLOWED_SENDERS ||
  process.env.SESSION_COMMAND_USER_IDS ||
  envConfig.SESSION_COMMAND_ALLOWED_SENDERS ||
  envConfig.SESSION_COMMAND_USER_IDS ||
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
