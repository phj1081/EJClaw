import fs from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';

import { readEnvFile } from '../src/env.js';
import { STORE_DIR } from '../src/config.js';
import {
  type AssignedRoomsSummary,
  detectRoomRegistrationState,
} from './room-registration-state.js';
import type { ServiceDef } from './service-defs.js';
import type { ServiceCheck } from './verify-services.js';

export type CredentialsStatus = 'configured' | 'missing';
export type VerifyStatus = 'success' | 'failed';

export interface RoleRoutingRequirementsSummary {
  tribunalRooms: number;
  activeArbiterTasks: number;
}

export interface VerifySummary extends AssignedRoomsSummary {
  status: VerifyStatus;
  servicesSummary: Record<string, string>;
  configuredChannels: string[];
  channelAuth: Record<string, string>;
  tribunalRooms: number;
  activeArbiterTasks: number;
  reviewerChannelConfigured: boolean;
  arbiterChannelConfigured: boolean;
}

export function detectCredentials(projectRoot: string): CredentialsStatus {
  const envFile = path.join(projectRoot, '.env');
  if (!fs.existsSync(envFile)) {
    return 'missing';
  }

  const envContent = fs.readFileSync(envFile, 'utf-8');
  return /^(CLAUDE_CODE_OAUTH_TOKENS?|ANTHROPIC_API_KEY)=/m.test(envContent)
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

export function loadAssignedRoomsSummary(
  options?: Parameters<typeof detectRoomRegistrationState>[0],
): AssignedRoomsSummary {
  return detectRoomRegistrationState(options);
}

export function loadRoleRoutingRequirementsSummary(
  options: {
    dbPath?: string;
  } = {},
): RoleRoutingRequirementsSummary {
  const dbPath = options.dbPath ?? path.join(STORE_DIR, 'messages.db');
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
              FROM room_settings
             WHERE room_mode = 'tribunal'
          `,
        )
        .get() as { count: number };
      tribunalRooms = roomModeRow.count;
    } catch {
      tribunalRooms = 0;
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
  roomSummary: AssignedRoomsSummary,
  options: {
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
  const reviewerChannelConfigured = 'discord-review' in channelAuth;
  const arbiterChannelConfigured = 'discord-arbiter' in channelAuth;
  const tribunalRooms = options.tribunalRooms ?? 0;
  const activeArbiterTasks = options.activeArbiterTasks ?? 0;
  const reviewerRoutingSatisfied =
    tribunalRooms === 0 || reviewerChannelConfigured;
  const arbiterRoutingSatisfied =
    activeArbiterTasks === 0 || arbiterChannelConfigured;

  const status =
    allConfiguredServicesRunning &&
    credentials === 'configured' &&
    hasOwnerCapableChannel &&
    reviewerRoutingSatisfied &&
    arbiterRoutingSatisfied &&
    roomSummary.assignedRooms > 0 &&
    !roomSummary.legacyRoomMigrationRequired &&
    !roomSummary.unexpectedDataStateDetected
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
    tribunalRooms,
    activeArbiterTasks,
    ...roomSummary,
    reviewerChannelConfigured,
    arbiterChannelConfigured,
  };
}
