/**
 * Settings store for the web dashboard:
 *  - lists Claude / Codex accounts (safe metadata only, no tokens)
 *  - reads/writes model role configuration via .env
 *  - removes account directories on the filesystem
 *
 * Account directory layout (existing convention):
 *   Claude default:   ~/.claude/.credentials.json
 *   Claude index N≥1: ~/.claude-accounts/{N}/.credentials.json
 *   Codex default:    ~/.codex/auth.json
 *   Codex index N≥1:  ~/.codex-accounts/{N}/auth.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findCodexAccountIndexByAuthPath,
  getActiveCodexAuthPath,
  setCurrentCodexAccountIndex as setRotationIndex,
} from './codex-token-rotation.js';

export interface ClaudeAccountSummary {
  index: number;
  expiresAt: number | null;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  exists: boolean;
}

export interface CodexAccountSummary {
  index: number;
  accountId: string | null;
  email: string | null;
  planType: string | null;
  subscriptionUntil: string | null;
  subscriptionLastChecked: string | null;
  exists: boolean;
}

export interface ModelRoleConfig {
  model: string;
  effort: string;
}

export interface ModelConfigSnapshot {
  owner: ModelRoleConfig;
  reviewer: ModelRoleConfig;
  arbiter: ModelRoleConfig;
}

export interface FastModeSnapshot {
  codex: boolean;
  claude: boolean;
}

export interface CodexFeatureSnapshot {
  goals: boolean;
}

const ROLE_KEYS = ['OWNER', 'REVIEWER', 'ARBITER'] as const;

function envFilePath(): string {
  return path.join(process.cwd(), '.env');
}

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function claudeCredsPath(index: number): string {
  if (index === 0) {
    return path.join(os.homedir(), '.claude', '.credentials.json');
  }
  return path.join(
    os.homedir(),
    '.claude-accounts',
    String(index),
    '.credentials.json',
  );
}

function codexAuthPath(index: number): string {
  if (index === 0) {
    return path.join(os.homedir(), '.codex', 'auth.json');
  }
  return path.join(os.homedir(), '.codex-accounts', String(index), 'auth.json');
}

function readClaudeAccount(index: number): ClaudeAccountSummary | null {
  const file = claudeCredsPath(index);
  if (!fs.existsSync(file)) return null;
  const data = readJson<{ claudeAiOauth?: Record<string, unknown> }>(file);
  const oauth = data?.claudeAiOauth ?? {};
  return {
    index,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    scopes: Array.isArray(oauth.scopes) ? (oauth.scopes as string[]) : [],
    subscriptionType:
      typeof oauth.subscriptionType === 'string'
        ? oauth.subscriptionType
        : undefined,
    rateLimitTier:
      typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : undefined,
    exists: true,
  };
}

function readCodexAccount(index: number): CodexAccountSummary | null {
  const file = codexAuthPath(index);
  if (!fs.existsSync(file)) return null;
  const data = readJson<{
    OPENAI_API_KEY?: string;
    tokens?: { id_token?: string; access_token?: string };
  }>(file);
  const live = readCodexLiveStatus(index);
  let accountId: string | null = null;
  let email: string | null = null;
  let planType: string | null = null;
  let subscriptionUntil: string | null = null;
  let subscriptionLastChecked: string | null = null;
  const idToken = data?.tokens?.id_token;
  if (idToken && typeof idToken === 'string') {
    const parts = idToken.split('.');
    if (parts.length >= 2) {
      try {
        const payload = JSON.parse(
          Buffer.from(parts[1], 'base64').toString('utf-8'),
        ) as Record<string, unknown>;
        if (typeof payload.sub === 'string') accountId = payload.sub;
        if (typeof payload.email === 'string') email = payload.email;
        const auth = payload['https://api.openai.com/auth'] as
          | Record<string, unknown>
          | undefined;
        if (auth) {
          if (typeof auth.chatgpt_plan_type === 'string') {
            planType = auth.chatgpt_plan_type;
          }
          if (typeof auth.chatgpt_subscription_active_until === 'string') {
            subscriptionUntil = auth.chatgpt_subscription_active_until;
          }
          if (typeof auth.chatgpt_subscription_last_checked === 'string') {
            subscriptionLastChecked = auth.chatgpt_subscription_last_checked;
          }
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }
  // Live wham/usage data, written by refreshCodexAccount, takes precedence.
  if (live) {
    if (typeof live.plan_type === 'string') planType = live.plan_type;
    if (typeof live.email === 'string') email = live.email;
    subscriptionLastChecked = live.checked_at;
  }
  return {
    index,
    accountId,
    email,
    planType,
    subscriptionUntil,
    subscriptionLastChecked,
    exists: true,
  };
}

export function listClaudeAccounts(): ClaudeAccountSummary[] {
  const out: ClaudeAccountSummary[] = [];
  const def = readClaudeAccount(0);
  if (def) out.push(def);
  const dir = path.join(os.homedir(), '.claude-accounts');
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    const indices = entries
      .filter((e) => /^\d+$/.test(e))
      .map((e) => Number.parseInt(e, 10))
      .filter((n) => Number.isFinite(n) && n >= 1)
      .sort((a, b) => a - b);
    for (const i of indices) {
      const acc = readClaudeAccount(i);
      if (acc) out.push(acc);
    }
  }
  return out;
}

export function listCodexAccounts(): CodexAccountSummary[] {
  const out: CodexAccountSummary[] = [];
  const def = readCodexAccount(0);
  if (def) out.push(def);
  const dir = path.join(os.homedir(), '.codex-accounts');
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    const indices = entries
      .filter((e) => /^\d+$/.test(e))
      .map((e) => Number.parseInt(e, 10))
      .filter((n) => Number.isFinite(n) && n >= 1)
      .sort((a, b) => a - b);
    for (const i of indices) {
      const acc = readCodexAccount(i);
      if (acc) out.push(acc);
    }
  }
  return out;
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
  const fromProc = process.env[key];
  return fromProc;
}

export function getModelConfig(): ModelConfigSnapshot {
  const out: Partial<ModelConfigSnapshot> = {};
  for (const role of ROLE_KEYS) {
    const model = readEnvOrProcess(`${role}_MODEL`) ?? '';
    const effort = readEnvOrProcess(`${role}_EFFORT`) ?? '';
    (out as Record<string, ModelRoleConfig>)[role.toLowerCase()] = {
      model,
      effort,
    };
  }
  return out as ModelConfigSnapshot;
}

export interface ModelUpdateInput {
  owner?: Partial<ModelRoleConfig>;
  reviewer?: Partial<ModelRoleConfig>;
  arbiter?: Partial<ModelRoleConfig>;
}

function setOrInsertEnvLine(
  content: string,
  key: string,
  value: string,
): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    return content.replace(re, `${key}=${value}`);
  }
  const trimmed = content.replace(/\s*$/, '');
  return `${trimmed}\n${key}=${value}\n`;
}

export function updateModelConfig(
  input: ModelUpdateInput,
): ModelConfigSnapshot {
  const file = envFilePath();
  let content = '';
  if (fs.existsSync(file)) {
    content = fs.readFileSync(file, 'utf-8');
  }

  for (const role of ROLE_KEYS) {
    const update = (
      input as Record<string, Partial<ModelRoleConfig> | undefined>
    )[role.toLowerCase()];
    if (!update) continue;
    if (update.model !== undefined) {
      content = setOrInsertEnvLine(content, `${role}_MODEL`, update.model);
    }
    if (update.effort !== undefined) {
      content = setOrInsertEnvLine(content, `${role}_EFFORT`, update.effort);
    }
  }

  const tempPath = `${file}.tmp`;
  fs.writeFileSync(tempPath, content, { mode: 0o600 });
  fs.renameSync(tempPath, file);

  return getModelConfig();
}

const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface CodexLiveStatus {
  checked_at: string;
  plan_type?: string | null;
  email?: string | null;
}

function planStatusPath(index: number): string {
  if (index === 0) {
    return path.join(os.homedir(), '.codex', 'plan-status.json');
  }
  return path.join(
    os.homedir(),
    '.codex-accounts',
    String(index),
    'plan-status.json',
  );
}

function readCodexLiveStatus(index: number): CodexLiveStatus | null {
  return readJson<CodexLiveStatus>(planStatusPath(index));
}

function writeCodexLiveStatus(index: number, status: CodexLiveStatus): void {
  const file = planStatusPath(index);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempPath = `${file}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(status, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tempPath, file);
}

async function fetchCodexLivePlanType(
  accessToken: string,
): Promise<{ plan_type?: string; email?: string } | null> {
  try {
    const res = await fetch(CODEX_USAGE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      plan_type?: unknown;
      email?: unknown;
    };
    return {
      plan_type:
        typeof json.plan_type === 'string' ? json.plan_type : undefined,
      email: typeof json.email === 'string' ? json.email : undefined,
    };
  } catch {
    return null;
  }
}

function readCodexAuthFile(file: string): CodexAuthFile | null {
  return readJson<CodexAuthFile>(file);
}

function writeCodexAuthFile(file: string, data: CodexAuthFile): void {
  const tempPath = `${file}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tempPath, file);
}

export async function refreshCodexAccount(
  index: number,
): Promise<CodexAccountSummary> {
  const file = codexAuthPath(index);
  if (!fs.existsSync(file)) {
    throw new Error(`codex auth.json not found for index ${index}`);
  }
  const data = readCodexAuthFile(file);
  const refreshToken = data?.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error(`codex account #${index} has no refresh_token`);
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });

  const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `codex refresh failed (#${index}): ${res.status} ${text.slice(0, 200)}`,
    );
  }

  const payload = (await res.json()) as {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
  };

  const updated: CodexAuthFile = {
    ...(data ?? {}),
    tokens: {
      ...(data?.tokens ?? {}),
      id_token: payload.id_token ?? data?.tokens?.id_token,
      access_token: payload.access_token ?? data?.tokens?.access_token,
      refresh_token: payload.refresh_token ?? refreshToken,
    },
    last_refresh: new Date().toISOString(),
  };
  writeCodexAuthFile(file, updated);

  // Hit chatgpt.com/backend-api/wham/usage to read the live plan_type
  // (the JWT id_token's chatgpt_plan_type / *_active_until / *_last_checked
  // claims are cached on OpenAI's auth0 side and don't refresh on every
  // OAuth refresh_token grant). Persist the live values to a sidecar
  // plan-status.json so readCodexAccount can prefer them.
  const accessToken =
    payload.access_token ?? data?.tokens?.access_token ?? null;
  if (accessToken) {
    const live = await fetchCodexLivePlanType(accessToken);
    if (live) {
      writeCodexLiveStatus(index, {
        checked_at: new Date().toISOString(),
        plan_type: live.plan_type ?? null,
        email: live.email ?? null,
      });
    }
  }

  const summary = readCodexAccount(index);
  if (!summary)
    throw new Error('failed to re-read codex account after refresh');
  return summary;
}

/**
 * settings-store lists codex accounts in an order that includes the default
 * `~/.codex/auth.json` as index 0 plus `~/.codex-accounts/{N}` as index N.
 * The rotation array (codex-token-rotation) only loads `~/.codex-accounts/{N}`
 * when those dirs exist (it ignores `~/.codex/auth.json` in that mode), so its
 * array indices are off-by-one vs. the settings indices. Translate via path.
 */
export function getActiveCodexSettingsIndex(): number | null {
  const activePath = getActiveCodexAuthPath();
  if (!activePath) return null;
  // Walk the same listing order as listCodexAccounts() to find the matching
  // settings-store index.
  if (codexAuthPath(0) === activePath && fs.existsSync(activePath)) {
    return 0;
  }
  const dir = path.join(os.homedir(), '.codex-accounts');
  if (fs.existsSync(dir)) {
    const indices = fs
      .readdirSync(dir)
      .filter((e) => /^\d+$/.test(e))
      .map((e) => Number.parseInt(e, 10))
      .filter((n) => Number.isFinite(n) && n >= 1)
      .sort((a, b) => a - b);
    for (const i of indices) {
      if (codexAuthPath(i) === activePath) return i;
    }
  }
  return null;
}

export function setActiveCodexSettingsIndex(settingsIndex: number): void {
  const file = codexAuthPath(settingsIndex);
  if (!fs.existsSync(file)) {
    throw new Error(
      `codex auth.json not found for settings index ${settingsIndex}`,
    );
  }
  const rotationIndex = findCodexAccountIndexByAuthPath(file);
  if (rotationIndex === null) {
    throw new Error(
      `codex switch: settings #${settingsIndex} (${file}) is not part of the rotation pool. ` +
        `Rotation only manages accounts under ~/.codex-accounts/. ` +
        `If you want to use ~/.codex/auth.json directly, remove the ~/.codex-accounts dir first.`,
    );
  }
  setRotationIndex(rotationIndex);
}

export async function refreshAllCodexAccounts(): Promise<{
  refreshed: number[];
  failed: Array<{ index: number; error: string }>;
}> {
  const refreshed: number[] = [];
  const failed: Array<{ index: number; error: string }> = [];
  const accounts = listCodexAccounts();
  for (const acc of accounts) {
    try {
      await refreshCodexAccount(acc.index);
      refreshed.push(acc.index);
    } catch (err) {
      failed.push({
        index: acc.index,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { refreshed, failed };
}

const CODEX_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
let codexRefreshTimer: ReturnType<typeof setInterval> | null = null;

export function startCodexAccountRefreshLoop(): void {
  if (codexRefreshTimer) return;
  // Stagger first refresh so server boot isn't slowed.
  setTimeout(() => {
    void refreshAllCodexAccounts().catch(() => {
      /* swallow; per-account errors logged inside */
    });
  }, 60_000).unref?.();
  codexRefreshTimer = setInterval(() => {
    void refreshAllCodexAccounts().catch(() => {
      /* swallow */
    });
  }, CODEX_REFRESH_INTERVAL_MS);
  codexRefreshTimer.unref?.();
}

export function stopCodexAccountRefreshLoop(): void {
  if (codexRefreshTimer) {
    clearInterval(codexRefreshTimer);
    codexRefreshTimer = null;
  }
}

function codexConfigPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function claudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readCodexFastMode(): boolean {
  const file = codexConfigPath();
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file, 'utf-8');
  // [features] section, look for fast_mode = true|false
  const featuresMatch = content.match(/\[features\][\s\S]*?(?=^\[|$)/m);
  const block = featuresMatch ? featuresMatch[0] : content;
  const m = block.match(/^\s*fast_mode\s*=\s*(true|false)\s*$/m);
  return m ? m[1] === 'true' : false;
}

function writeCodexFastMode(value: boolean): void {
  const file = codexConfigPath();
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  if (/^\s*fast_mode\s*=\s*(true|false)\s*$/m.test(content)) {
    content = content.replace(
      /^\s*fast_mode\s*=\s*(true|false)\s*$/m,
      `fast_mode = ${value}`,
    );
  } else if (/^\[features\]/m.test(content)) {
    content = content.replace(
      /^\[features\]\s*$/m,
      `[features]\nfast_mode = ${value}`,
    );
  } else {
    const trimmed = content.replace(/\s*$/, '');
    content = `${trimmed}\n\n[features]\nfast_mode = ${value}\n`;
  }
  const tempPath = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tempPath, content, { mode: 0o600 });
  fs.renameSync(tempPath, file);
}

function readClaudeFastMode(): boolean {
  const file = claudeSettingsPath();
  if (!fs.existsSync(file)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<
      string,
      unknown
    >;
    return data.fastMode === true;
  } catch {
    return false;
  }
}

function writeClaudeFastMode(value: boolean): void {
  const file = claudeSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      data = {};
    }
  }
  data.fastMode = value;
  const tempPath = `${file}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tempPath, file);
}

export function getFastMode(): FastModeSnapshot {
  return {
    codex: readCodexFastMode(),
    claude: readClaudeFastMode(),
  };
}

export function updateFastMode(
  input: Partial<FastModeSnapshot>,
): FastModeSnapshot {
  if (typeof input.codex === 'boolean') writeCodexFastMode(input.codex);
  if (typeof input.claude === 'boolean') writeClaudeFastMode(input.claude);
  return getFastMode();
}

function readCodexGoals(): boolean {
  return readEnvOrProcess('CODEX_GOALS') === 'true';
}

function writeCodexGoals(value: boolean): void {
  const file = envFilePath();
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const updated = setOrInsertEnvLine(
    content,
    'CODEX_GOALS',
    value ? 'true' : 'false',
  );
  const tempPath = `${file}.tmp`;
  fs.writeFileSync(tempPath, updated, { mode: 0o600 });
  fs.renameSync(tempPath, file);
}

export function getCodexFeatures(): CodexFeatureSnapshot {
  return {
    goals: readCodexGoals(),
  };
}

export function updateCodexFeatures(
  input: Partial<CodexFeatureSnapshot>,
): CodexFeatureSnapshot {
  if (typeof input.goals === 'boolean') writeCodexGoals(input.goals);
  return getCodexFeatures();
}

export function removeAccountDirectory(
  provider: 'claude' | 'codex',
  index: number,
): void {
  if (!Number.isFinite(index) || index < 1) {
    throw new Error('cannot remove default account (index 0)');
  }
  const baseDir =
    provider === 'claude'
      ? path.join(os.homedir(), '.claude-accounts', String(index))
      : path.join(os.homedir(), '.codex-accounts', String(index));
  if (!fs.existsSync(baseDir)) {
    throw new Error(`account directory not found: ${baseDir}`);
  }
  fs.rmSync(baseDir, { recursive: true, force: true });
}

export function addClaudeAccountFromToken(token: string): {
  index: number;
  accountId: string | null;
} {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('empty token');

  const parts = trimmed.split('.');
  if (parts.length < 2) {
    throw new Error('invalid OAuth token: expected JWT format');
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(
      Buffer.from(parts[1], 'base64').toString('utf-8'),
    ) as Record<string, unknown>;
  } catch {
    throw new Error('invalid OAuth token: payload not parseable');
  }
  const exp = typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  const accountId = typeof payload.sub === 'string' ? payload.sub : null;

  const baseDir = path.join(os.homedir(), '.claude-accounts');
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  }

  let nextIndex = 1;
  while (
    fs.existsSync(path.join(baseDir, String(nextIndex), '.credentials.json'))
  ) {
    nextIndex += 1;
  }
  const dir = path.join(baseDir, String(nextIndex));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const creds = {
    claudeAiOauth: {
      accessToken: trimmed,
      refreshToken: '',
      expiresAt: exp,
      scopes: ['user:profile', 'user:inference'],
    },
  };
  const credsPath = path.join(dir, '.credentials.json');
  const tempPath = `${credsPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, credsPath);

  return { index: nextIndex, accountId };
}
