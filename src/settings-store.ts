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
  planType: string | null;
  subscriptionUntil: string | null;
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

const ROLE_KEYS = ['OWNER', 'REVIEWER', 'ARBITER'] as const;
type RoleKey = (typeof ROLE_KEYS)[number];

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
  return path.join(
    os.homedir(),
    '.codex-accounts',
    String(index),
    'auth.json',
  );
}

function readClaudeAccount(index: number): ClaudeAccountSummary | null {
  const file = claudeCredsPath(index);
  if (!fs.existsSync(file)) return null;
  const data = readJson<{ claudeAiOauth?: Record<string, unknown> }>(file);
  const oauth = data?.claudeAiOauth ?? {};
  return {
    index,
    expiresAt:
      typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    scopes: Array.isArray(oauth.scopes) ? (oauth.scopes as string[]) : [],
    subscriptionType:
      typeof oauth.subscriptionType === 'string'
        ? oauth.subscriptionType
        : undefined,
    rateLimitTier:
      typeof oauth.rateLimitTier === 'string'
        ? oauth.rateLimitTier
        : undefined,
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
  let accountId: string | null = null;
  let planType: string | null = null;
  let subscriptionUntil: string | null = null;
  const idToken = data?.tokens?.id_token;
  if (idToken && typeof idToken === 'string') {
    const parts = idToken.split('.');
    if (parts.length >= 2) {
      try {
        const payload = JSON.parse(
          Buffer.from(parts[1], 'base64').toString('utf-8'),
        ) as Record<string, unknown>;
        if (typeof payload.sub === 'string') accountId = payload.sub;
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
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }
  return {
    index,
    accountId,
    planType,
    subscriptionUntil,
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

export function updateModelConfig(input: ModelUpdateInput): ModelConfigSnapshot {
  const file = envFilePath();
  let content = '';
  if (fs.existsSync(file)) {
    content = fs.readFileSync(file, 'utf-8');
  }

  for (const role of ROLE_KEYS) {
    const update = (input as Record<string, Partial<ModelRoleConfig> | undefined>)[
      role.toLowerCase()
    ];
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
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(
      Buffer.from(parts[1], 'base64').toString('utf-8'),
    ) as Record<string, unknown>;
  } catch {
    throw new Error('invalid OAuth token: payload not parseable');
  }
  const exp = typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  const accountId =
    typeof payload.sub === 'string' ? payload.sub : null;

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
