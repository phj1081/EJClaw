import os from 'os';
import path from 'path';

import type { MoaConfig, MoaModelConfig } from '../moa.js';
import type { AgentType } from '../types.js';
import { getEnv } from '../env.js';

import type { AppConfig, RoleModelConfig } from './schema.js';

function readText(key: string): string | undefined {
  return getEnv(key);
}

function readNonEmptyText(key: string): string | undefined {
  const value = getEnv(key);
  return value === '' ? undefined : value;
}

function readBoolean(key: string, fallback = false): boolean {
  const value = readText(key);
  if (value == null || value === '') return fallback;
  return value === 'true';
}

function readBooleanUnlessFalse(key: string, fallback = true): boolean {
  const value = readText(key);
  if (value == null || value === '') return fallback;
  return value !== 'false';
}

function readInteger(key: string, fallback: number): number {
  const value = readNonEmptyText(key);
  if (value == null) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readIntegerAtLeast(
  key: string,
  fallback: number,
  minimum: number,
): number {
  return Math.max(minimum, readInteger(key, fallback) || fallback);
}

function readAgentType(
  key: string,
  fallback?: AgentType,
): AgentType | undefined {
  const value = readText(key);
  if (value === 'codex' || value === 'claude-code') return value;
  return fallback;
}

function buildRoleModelConfig(envPrefix: string): RoleModelConfig {
  return {
    model: readNonEmptyText(`${envPrefix}_MODEL`),
    effort: readNonEmptyText(`${envPrefix}_EFFORT`),
    fallbackEnabled: readText(`${envPrefix}_FALLBACK_ENABLED`) !== 'false',
  };
}

function parseMoaReferenceModels(): MoaModelConfig[] {
  const names = (readText('MOA_REF_MODELS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return names
    .map((name) => {
      const prefix = `MOA_${name.toUpperCase()}`;
      const model = readNonEmptyText(`${prefix}_MODEL`) ?? '';
      const baseUrl = readNonEmptyText(`${prefix}_BASE_URL`) ?? '';
      const apiKey = readNonEmptyText(`${prefix}_API_KEY`) ?? '';
      if (!model || !baseUrl || !apiKey) return null;
      const rawFormat = readText(`${prefix}_API_FORMAT`) ?? '';
      const apiFormat: 'openai' | 'anthropic' =
        rawFormat === 'anthropic' ? 'anthropic' : 'openai';
      return { name, model, baseUrl, apiKey, apiFormat };
    })
    .filter((value): value is MoaModelConfig => value !== null);
}

function buildMoaConfig(): MoaConfig {
  const referenceModels = parseMoaReferenceModels();
  return {
    enabled: readText('MOA_ENABLED') === 'true' && referenceModels.length > 0,
    referenceModels,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeServiceId(
  serviceId: string,
  codexMainServiceId: string,
): string {
  return serviceId === 'codex' ? codexMainServiceId : serviceId;
}

export function loadConfig(): AppConfig {
  const assistantName = readText('ASSISTANT_NAME') ?? 'Andy';
  const assistantSlug = assistantName.trim().toLowerCase();

  const claudeServiceId = readText('CLAUDE_SERVICE_ID') ?? 'claude';
  const codexMainServiceId = readText('CODEX_MAIN_SERVICE_ID') ?? 'codex-main';
  const codexReviewServiceId =
    readText('CODEX_REVIEW_SERVICE_ID') ?? 'codex-review';
  const serviceId = readText('SERVICE_ID') ?? assistantSlug;
  const serviceSessionScope = normalizeServiceId(serviceId, codexMainServiceId);

  const ownerAgentType = readAgentType('OWNER_AGENT_TYPE', 'codex') ?? 'codex';
  const reviewerAgentType =
    readAgentType('REVIEWER_AGENT_TYPE', 'claude-code') ?? 'claude-code';
  const arbiterAgentType = readAgentType('ARBITER_AGENT_TYPE');

  const projectRoot = process.cwd();
  const homeDir = readNonEmptyText('HOME') ?? os.homedir();

  const rawMaxRoundTrips = readText('PAIRED_MAX_ROUND_TRIPS');
  const maxRoundTrips =
    rawMaxRoundTrips === '0' ? Infinity : readInteger('PAIRED_MAX_ROUND_TRIPS', 1000);

  return {
    assistant: {
      name: assistantName,
      hasOwnNumber: readBoolean('ASSISTANT_HAS_OWN_NUMBER', false),
      slug: assistantSlug,
      triggerPattern: new RegExp(`^@${escapeRegex(assistantName)}\\b`, 'i'),
    },
    service: {
      id: serviceId,
      sessionScope: serviceSessionScope,
      claudeId: claudeServiceId,
      codexMainId: codexMainServiceId,
      codexReviewId: codexReviewServiceId,
    },
    paths: {
      projectRoot,
      homeDir,
      senderAllowlistPath: path.join(
        homeDir,
        '.config',
        'ejclaw',
        'sender-allowlist.json',
      ),
      storeDir: path.resolve(
        readNonEmptyText('EJCLAW_STORE_DIR') ?? path.join(projectRoot, 'store'),
      ),
      groupsDir: path.resolve(
        readNonEmptyText('EJCLAW_GROUPS_DIR') ??
          path.join(projectRoot, 'groups'),
      ),
      dataDir: path.resolve(
        readNonEmptyText('EJCLAW_DATA_DIR') ?? path.join(projectRoot, 'data'),
      ),
      cacheDir: path.resolve(
        readNonEmptyText('EJCLAW_CACHE_DIR') ??
          path.join(projectRoot, 'cache'),
      ),
    },
    runtime: {
      pollInterval: 2000,
      schedulerPollInterval: 60000,
      failoverMinDurationMs: 3 * 60 * 60 * 1000,
      agentTimeout: readInteger('AGENT_TIMEOUT', 1_800_000),
      agentMaxOutputSize: readInteger('AGENT_MAX_OUTPUT_SIZE', 10_485_760),
      ipcPollInterval: 1000,
      idleTimeout: readInteger('IDLE_TIMEOUT', 1_800_000),
      maxConcurrentAgents: readIntegerAtLeast('MAX_CONCURRENT_AGENTS', 5, 1),
      recoveryConcurrentAgents: readInteger('RECOVERY_CONCURRENT_AGENTS', 3),
      recoveryStaggerMs: readInteger('RECOVERY_STAGGER_MS', 2000),
      recoveryDurationMs: readInteger('RECOVERY_DURATION_MS', 60000),
    },
    logging: {
      level: readText('LOG_LEVEL') ?? 'info',
      isTestEnv:
        readText('VITEST') === 'true' || readText('NODE_ENV') === 'test',
    },
    paired: {
      ownerAgentType,
      reviewerAgentType,
      reviewerServiceIdForType:
        reviewerAgentType === 'claude-code'
          ? claudeServiceId
          : codexReviewServiceId,
      arbiterAgentType,
      arbiterServiceId: arbiterAgentType
        ? (readText('ARBITER_SERVICE_ID') ?? codexReviewServiceId)
        : null,
      agentLanguage: readText('AGENT_LANGUAGE') ?? '',
      arbiterDeadlockThreshold: readInteger('ARBITER_DEADLOCK_THRESHOLD', 2),
      maxRoundTrips,
    },
    models: {
      owner: buildRoleModelConfig('OWNER'),
      reviewer: buildRoleModelConfig('REVIEWER'),
      arbiter: buildRoleModelConfig('ARBITER'),
    },
    providers: {
      claudeDefaultModel: readText('CLAUDE_MODEL') ?? 'claude',
      codexDefaultModel: readText('CODEX_MODEL') ?? 'codex',
    },
    moa: buildMoaConfig(),
    status: {
      channelId: readText('STATUS_CHANNEL_ID') ?? '',
      updateInterval: 10000,
      usageUpdateInterval: 300000,
      showRooms: readBooleanUnlessFalse('STATUS_SHOW_ROOMS', true),
      showRoomDetails: readBooleanUnlessFalse('STATUS_SHOW_ROOM_DETAILS', true),
      usageDashboardEnabled: readText('USAGE_DASHBOARD') === 'true',
      timezone:
        readText('TZ') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    sessionCommands: {
      allowedSenders: new Set(
        ((readText('SESSION_COMMAND_ALLOWED_SENDERS') ??
          readText('SESSION_COMMAND_USER_IDS')) ??
          '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    },
    deltaHandoff: {
      enabled: readText('DELTA_HANDOFF_ENABLED') === 'true',
      canaryGroups: new Set(
        (readText('DELTA_HANDOFF_CANARY_GROUPS') ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    },
  };
}
