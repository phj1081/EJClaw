import fs from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

import { STORE_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import type { ServiceDef } from './service-defs.js';
import type { ServiceCheck } from './verify-services.js';

export type CredentialsStatus = 'configured' | 'missing';
export type VerifyStatus = 'success' | 'failed';

const LEGACY_DISCORD_TOKEN_KEYS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CODEX_BOT_TOKEN',
  'DISCORD_REVIEW_BOT_TOKEN',
  'DISCORD_CLAUDE_BOT_TOKEN',
  'DISCORD_CODEX_MAIN_BOT_TOKEN',
  'DISCORD_CODEX_REVIEW_BOT_TOKEN',
];

export interface RegisteredGroupsSummary {
  registeredGroups: number;
  groupsByAgent: Record<string, number>;
}

export interface RoleRoutingRequirementsSummary {
  tribunalRooms: number;
  activeArbiterTasks: number;
}

export interface VerifySummary extends RegisteredGroupsSummary {
  status: VerifyStatus;
  servicesSummary: Record<string, string>;
  configuredChannels: string[];
  channelAuth: Record<string, string>;
  legacyDiscordTokenKeys: string[];
  tribunalRooms: number;
  activeArbiterTasks: number;
  // Legacy status fields kept for backward-compatible setup output.
  codexConfigured: boolean;
  reviewConfigured: boolean;
}

export function detectCredentials(projectRoot: string): CredentialsStatus {
  const envFile = path.join(projectRoot, '.env');
  if (!fs.existsSync(envFile)) {
    return 'missing';
  }

  const envContent = fs.readFileSync(envFile, 'utf-8');
  return /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(envContent)
    ? 'configured'
    : 'missing';
}

export function detectChannelAuth(
  envVars = readEnvFile([
    'DISCORD_OWNER_BOT_TOKEN',
    'DISCORD_REVIEWER_BOT_TOKEN',
    'DISCORD_ARBITER_BOT_TOKEN',
  ]),
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const channelAuth: Record<string, string> = {};

  const hasEnv = (key: string): boolean => !!(processEnv[key] || envVars[key]);

  if (hasEnv('DISCORD_OWNER_BOT_TOKEN')) {
    channelAuth.discord = 'configured';
  }
  if (hasEnv('DISCORD_REVIEWER_BOT_TOKEN')) {
    channelAuth['discord-review'] = 'configured';
  }
  if (hasEnv('DISCORD_ARBITER_BOT_TOKEN')) {
    channelAuth['discord-arbiter'] = 'configured';
  }

  return channelAuth;
}

export function detectLegacyDiscordTokenKeys(
  envVars = readEnvFile(LEGACY_DISCORD_TOKEN_KEYS),
  processEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  return LEGACY_DISCORD_TOKEN_KEYS.filter(
    (key) => !!(processEnv[key] || envVars[key]),
  );
}

export function loadRegisteredGroupsSummary(
  dbPath = path.join(STORE_DIR, 'messages.db'),
): RegisteredGroupsSummary {
  let registeredGroups = 0;
  const groupsByAgent: Record<string, number> = {};

  if (!fs.existsSync(dbPath)) {
    return { registeredGroups, groupsByAgent };
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT COUNT(*) as count FROM registered_groups')
      .get() as { count: number };
    registeredGroups = row.count;

    try {
      const rows = db
        .prepare(
          'SELECT agent_type, COUNT(*) as count FROM registered_groups GROUP BY agent_type',
        )
        .all() as { agent_type: string; count: number }[];
      for (const current of rows) {
        groupsByAgent[current.agent_type || 'unknown'] = current.count;
      }
    } catch {
      // agent_type column might not exist in older schema
    }

    db.close();
  } catch {
    // Table might not exist
  }

  return { registeredGroups, groupsByAgent };
}

export function loadRoleRoutingRequirementsSummary(
  dbPath = path.join(STORE_DIR, 'messages.db'),
): RoleRoutingRequirementsSummary {
  let tribunalRooms = 0;
  let activeArbiterTasks = 0;

  if (!fs.existsSync(dbPath)) {
    return { tribunalRooms, activeArbiterTasks };
  }

  try {
    const db = new Database(dbPath, { readonly: true });

    try {
      const roomModeRow = db
        .prepare(
          `
            SELECT COUNT(*) as count
              FROM (
                SELECT chat_jid AS jid
                  FROM room_settings
                 WHERE room_mode = 'tribunal'
                UNION
                SELECT jid
                  FROM registered_groups
                 GROUP BY jid
                HAVING COUNT(DISTINCT agent_type) > 1
              )
          `,
        )
        .get() as { count: number };
      tribunalRooms = roomModeRow.count;
    } catch {
      try {
        const fallbackRow = db
          .prepare(
            `
              SELECT COUNT(*) as count
                FROM (
                  SELECT jid
                    FROM registered_groups
                   GROUP BY jid
                  HAVING COUNT(DISTINCT agent_type) > 1
                )
            `,
          )
          .get() as { count: number };
        tribunalRooms = fallbackRow.count;
      } catch {
        tribunalRooms = 0;
      }
    }

    try {
      const arbiterRow = db
        .prepare(
          `
            SELECT COUNT(*) as count
              FROM paired_tasks
             WHERE status IN ('arbiter_requested', 'in_arbitration')
          `,
        )
        .get() as { count: number };
      activeArbiterTasks = arbiterRow.count;
    } catch {
      activeArbiterTasks = 0;
    }

    db.close();
  } catch {
    // Tables might not exist yet
  }

  return { tribunalRooms, activeArbiterTasks };
}

export function buildVerifySummary(
  services: ServiceCheck[],
  serviceDefs: ServiceDef[],
  credentials: CredentialsStatus,
  channelAuth: Record<string, string>,
  registeredGroups: number,
  groupsByAgent: Record<string, number>,
  options: {
    legacyDiscordTokenKeys?: string[];
    tribunalRooms?: number;
    activeArbiterTasks?: number;
  } = {},
): VerifySummary {
  void serviceDefs;
  const configuredChannels = Object.keys(channelAuth);
  const allConfiguredServicesRunning = services.every(
    (service) => service.status === 'running',
  );
  const hasOwnerCapableChannel = 'discord' in channelAuth;
  const codexConfigured = 'discord-review' in channelAuth;
  const reviewConfigured = 'discord-arbiter' in channelAuth;
  const legacyDiscordTokenKeys = options.legacyDiscordTokenKeys ?? [];
  const tribunalRooms = options.tribunalRooms ?? 0;
  const activeArbiterTasks = options.activeArbiterTasks ?? 0;
  const reviewerConfigured = tribunalRooms === 0 || codexConfigured;
  const arbiterConfigured = activeArbiterTasks === 0 || reviewConfigured;

  const status =
    allConfiguredServicesRunning &&
    credentials === 'configured' &&
    hasOwnerCapableChannel &&
    legacyDiscordTokenKeys.length === 0 &&
    reviewerConfigured &&
    arbiterConfigured &&
    registeredGroups > 0
      ? 'success'
      : 'failed';

  const servicesSummary: Record<string, string> = {};
  for (const service of services) {
    servicesSummary[service.name] = service.status;
  }

  return {
    status,
    servicesSummary,
    configuredChannels,
    channelAuth,
    legacyDiscordTokenKeys,
    tribunalRooms,
    activeArbiterTasks,
    registeredGroups,
    groupsByAgent,
    codexConfigured,
    reviewConfigured,
  };
}
