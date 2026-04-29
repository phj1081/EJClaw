import fs from 'node:fs';
import path from 'node:path';

import {
  getMoaReferenceStatuses,
  probeMoaReferenceModel,
  type MoaModelConfig,
  type MoaReferenceStatus,
} from './moa.js';

export interface MoaModelSettingsSnapshot {
  name: string;
  enabled: boolean;
  model: string;
  baseUrl: string;
  apiFormat: 'openai' | 'anthropic';
  apiKeyConfigured: boolean;
  lastStatus: MoaReferenceStatus | null;
}

export interface MoaSettingsSnapshot {
  enabled: boolean;
  referenceModels: string[];
  models: MoaModelSettingsSnapshot[];
}

export interface MoaModelSettingsUpdate {
  name: string;
  enabled?: boolean;
  model?: string;
  baseUrl?: string;
  apiFormat?: 'openai' | 'anthropic';
  apiKey?: string;
}

export interface MoaSettingsUpdateInput {
  enabled?: boolean;
  models?: MoaModelSettingsUpdate[];
}

const DEFAULT_MOA_MODEL_NAMES = ['kimi', 'glm'] as const;

function envFilePath(): string {
  return path.join(process.cwd(), '.env');
}

function pickEnvValue(content: string, key: string): string | undefined {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const match = content.match(re);
  if (!match) return undefined;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function readEnvFile(): string {
  const file = envFilePath();
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

function readEnvOrProcess(key: string): string | undefined {
  const fromFile = pickEnvValue(readEnvFile(), key);
  if (fromFile !== undefined) return fromFile;
  return process.env[key];
}

function listSettingsEnvKeys(): string[] {
  const keys = new Set<string>();
  for (const line of readEnvFile().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) keys.add(trimmed.slice(0, eqIdx).trim());
  }
  for (const key of Object.keys(process.env)) keys.add(key);
  return [...keys].sort();
}

function parseCommaList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeMoaModelName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(normalized)) {
    throw new Error(`invalid MoA model name: ${name}`);
  }
  return normalized;
}

function moaPrefix(name: string): string {
  return `MOA_${normalizeMoaModelName(name).toUpperCase()}`;
}

function sanitizeEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error('env values must not contain newlines');
  }
  return value.trim();
}

function setOrInsertEnvLine(
  content: string,
  key: string,
  value: string,
): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) return content.replace(re, `${key}=${value}`);
  const trimmed = content.replace(/\s*$/, '');
  return `${trimmed}\n${key}=${value}\n`;
}

function configuredMoaModelNames(): string[] {
  const names = new Set<string>(DEFAULT_MOA_MODEL_NAMES);
  for (const name of parseCommaList(readEnvOrProcess('MOA_REF_MODELS'))) {
    names.add(normalizeMoaModelName(name));
  }
  for (const key of listSettingsEnvKeys()) {
    const match = key.match(
      /^MOA_([A-Z0-9_]+)_(MODEL|BASE_URL|API_KEY|API_FORMAT)$/,
    );
    if (match) names.add(match[1].toLowerCase());
  }
  return [...names].sort((a, b) => {
    const defaultA = DEFAULT_MOA_MODEL_NAMES.indexOf(
      a as (typeof DEFAULT_MOA_MODEL_NAMES)[number],
    );
    const defaultB = DEFAULT_MOA_MODEL_NAMES.indexOf(
      b as (typeof DEFAULT_MOA_MODEL_NAMES)[number],
    );
    if (defaultA !== -1 || defaultB !== -1) {
      if (defaultA === -1) return 1;
      if (defaultB === -1) return -1;
      return defaultA - defaultB;
    }
    return a.localeCompare(b);
  });
}

function readMoaModelConfig(name: string): MoaModelConfig | null {
  const normalized = normalizeMoaModelName(name);
  const prefix = moaPrefix(normalized);
  const model = readEnvOrProcess(`${prefix}_MODEL`) ?? '';
  const baseUrl = readEnvOrProcess(`${prefix}_BASE_URL`) ?? '';
  const apiKey = readEnvOrProcess(`${prefix}_API_KEY`) ?? '';
  const rawFormat = readEnvOrProcess(`${prefix}_API_FORMAT`) ?? '';
  const apiFormat: 'openai' | 'anthropic' =
    rawFormat === 'anthropic' ? 'anthropic' : 'openai';
  if (!model || !baseUrl || !apiKey) return null;
  return { name: normalized, model, baseUrl, apiKey, apiFormat };
}

export function getMoaSettings(): MoaSettingsSnapshot {
  const referenceModels = parseCommaList(
    readEnvOrProcess('MOA_REF_MODELS'),
  ).map(normalizeMoaModelName);
  const active = new Set(referenceModels);
  const statuses = new Map(
    getMoaReferenceStatuses().map((status) => [status.model, status]),
  );
  return {
    enabled: readEnvOrProcess('MOA_ENABLED') === 'true',
    referenceModels,
    models: configuredMoaModelNames().map((name) => {
      const prefix = moaPrefix(name);
      const rawFormat = readEnvOrProcess(`${prefix}_API_FORMAT`) ?? '';
      const apiFormat: 'openai' | 'anthropic' =
        rawFormat === 'anthropic' ? 'anthropic' : 'openai';
      return {
        name,
        enabled: active.has(name),
        model: readEnvOrProcess(`${prefix}_MODEL`) ?? '',
        baseUrl: readEnvOrProcess(`${prefix}_BASE_URL`) ?? '',
        apiFormat,
        apiKeyConfigured: Boolean(readEnvOrProcess(`${prefix}_API_KEY`)),
        lastStatus: statuses.get(name) ?? null,
      };
    }),
  };
}

export function updateMoaSettings(
  input: MoaSettingsUpdateInput,
): MoaSettingsSnapshot {
  const file = envFilePath();
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';

  if (typeof input.enabled === 'boolean') {
    content = setOrInsertEnvLine(
      content,
      'MOA_ENABLED',
      input.enabled ? 'true' : 'false',
    );
  }

  if (Array.isArray(input.models)) {
    const byName = new Map<string, MoaModelSettingsUpdate>();
    for (const update of input.models) {
      byName.set(normalizeMoaModelName(update.name), update);
    }
    content = applyMoaModelUpdates(content, byName);
  }

  const tempPath = `${file}.tmp`;
  fs.writeFileSync(tempPath, content, { mode: 0o600 });
  fs.renameSync(tempPath, file);

  return getMoaSettings();
}

function applyMoaModelUpdates(
  content: string,
  byName: Map<string, MoaModelSettingsUpdate>,
): string {
  let next = content;
  const allNames = new Set(configuredMoaModelNames());
  for (const name of byName.keys()) allNames.add(name);

  const enabledNames: string[] = [];
  for (const name of allNames) {
    const update = byName.get(name);
    const currentlyEnabled = parseCommaList(readEnvOrProcess('MOA_REF_MODELS'))
      .map(normalizeMoaModelName)
      .includes(name);
    if (update?.enabled ?? currentlyEnabled) enabledNames.push(name);
    if (update) next = applyMoaModelUpdate(next, name, update);
  }

  return setOrInsertEnvLine(next, 'MOA_REF_MODELS', enabledNames.join(','));
}

function applyMoaModelUpdate(
  content: string,
  name: string,
  update: MoaModelSettingsUpdate,
): string {
  let next = content;
  const prefix = moaPrefix(name);
  if (update.model !== undefined) {
    next = setOrInsertEnvLine(
      next,
      `${prefix}_MODEL`,
      sanitizeEnvValue(update.model),
    );
  }
  if (update.baseUrl !== undefined) {
    next = setOrInsertEnvLine(
      next,
      `${prefix}_BASE_URL`,
      sanitizeEnvValue(update.baseUrl),
    );
  }
  if (update.apiFormat !== undefined) {
    if (update.apiFormat !== 'openai' && update.apiFormat !== 'anthropic') {
      throw new Error(`invalid MoA API format for ${name}`);
    }
    next = setOrInsertEnvLine(next, `${prefix}_API_FORMAT`, update.apiFormat);
  }
  if (update.apiKey !== undefined && update.apiKey.trim() !== '') {
    next = setOrInsertEnvLine(
      next,
      `${prefix}_API_KEY`,
      sanitizeEnvValue(update.apiKey),
    );
  }
  return next;
}

export async function checkMoaModel(name: string): Promise<MoaReferenceStatus> {
  const config = readMoaModelConfig(name);
  if (!config) {
    throw new Error(`MoA model ${name} is missing model/baseUrl/apiKey`);
  }
  return probeMoaReferenceModel(config);
}
