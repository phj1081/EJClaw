/**
 * OAuth Token Auto-Refresh for Claude Code (Multi-Account)
 *
 * Periodically checks credentials files and refreshes access tokens
 * before they expire. Supports multiple accounts via CLAUDE_CODE_OAUTH_TOKENS.
 *
 * Account credential paths:
 *   - Account 0 (default): ~/.claude/.credentials.json
 *   - Account 1+: ~/.claude-accounts/{index}/.credentials.json
 *
 * After refresh, updates both the in-memory token rotation state and
 * the .env file so new tokens survive restarts.
 */
import fs from 'fs';
import os from 'os';
import { getErrorMessage, readJsonFile } from './utils.js';
import path from 'path';

import { logger } from './logger.js';
import { DATA_DIR } from './config.js';
import { getAllTokens, updateTokenValue } from './token-rotation.js';
import type { AgentType } from './types.js';

const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
];

// Check every 5 minutes, refresh if within 30 minutes of expiry
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const REFRESH_BEFORE_EXPIRY_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export function shouldStartTokenRefreshLoop(
  serviceAgentType: AgentType,
): boolean {
  return serviceAgentType === 'claude-code';
}

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface CredentialsFile {
  claudeAiOauth: OAuthCredentials;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

/**
 * Get the credentials file path for a given account index.
 *   - Index 0: ~/.claude/.credentials.json
 *   - Index 1+: ~/.claude-accounts/{index}/.credentials.json
 */
function getCredentialsPath(accountIndex: number): string {
  if (accountIndex === 0) {
    return path.join(os.homedir(), '.claude', '.credentials.json');
  }
  return path.join(
    os.homedir(),
    '.claude-accounts',
    String(accountIndex),
    '.credentials.json',
  );
}

function readCredentials(accountIndex: number): CredentialsFile | null {
  const credsPath = getCredentialsPath(accountIndex);
  if (!fs.existsSync(credsPath)) return null;
  const data = readJsonFile<CredentialsFile>(credsPath);
  if (!data) {
    logger.warn({ accountIndex }, 'Failed to read Claude credentials');
  }
  return data;
}

function writeCredentials(accountIndex: number, creds: CredentialsFile): void {
  const credsPath = getCredentialsPath(accountIndex);
  const dir = path.dirname(credsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tempPath = `${credsPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, credsPath);

  // Sync to all per-group session directories so running agents pick up the new token
  syncToSessionDirs(credsPath);
}

function syncToSessionDirs(credsPath: string): void {
  const sessionsDir = path.join(DATA_DIR, 'sessions');
  try {
    if (!fs.existsSync(sessionsDir)) return;
    const groups = fs.readdirSync(sessionsDir);
    let synced = 0;
    for (const group of groups) {
      const dest = path.join(
        sessionsDir,
        group,
        '.claude',
        '.credentials.json',
      );
      if (fs.existsSync(path.dirname(dest))) {
        fs.copyFileSync(credsPath, dest);
        synced++;
      }
    }
    if (synced > 0) {
      logger.info(
        { count: synced },
        'Synced credentials to session directories',
      );
    }
  } catch (err) {
    logger.warn(
      { err: getErrorMessage(err) },
      'Failed to sync credentials to sessions',
    );
  }
}

/**
 * Update CLAUDE_CODE_OAUTH_TOKENS in .env so refreshed tokens survive restarts.
 */
export function applyUpdatedTokensToEnvContent(
  content: string,
  tokens: string[],
): string {
  if (tokens.length === 0) return content;
  const multiValue = tokens.join(',');
  const multiLineRe = /^CLAUDE_CODE_OAUTH_TOKENS=.*/m;
  const singleLineRe = /^CLAUDE_CODE_OAUTH_TOKEN=.*/m;

  let next = content;
  if (multiLineRe.test(next)) {
    next = next.replace(multiLineRe, `CLAUDE_CODE_OAUTH_TOKENS=${multiValue}`);
  } else {
    next = `${next.replace(/\s*$/, '')}\nCLAUDE_CODE_OAUTH_TOKENS=${multiValue}\n`;
  }

  if (singleLineRe.test(next)) {
    next = next.replace(singleLineRe, `CLAUDE_CODE_OAUTH_TOKEN=${tokens[0]}`);
  }

  return next;
}

function updateEnvTokens(): void {
  const envFile = path.join(process.cwd(), '.env');
  try {
    if (!fs.existsSync(envFile)) return;
    const content = fs.readFileSync(envFile, 'utf-8');

    const allTokens = getAllTokens();
    if (allTokens.length === 0) return;

    const nextContent = applyUpdatedTokensToEnvContent(
      content,
      allTokens.map((t) => t.token),
    );

    const tempPath = `${envFile}.tmp`;
    fs.writeFileSync(tempPath, nextContent, { mode: 0o600 });
    fs.renameSync(tempPath, envFile);
    logger.debug('Updated .env with refreshed tokens');
  } catch (err) {
    logger.warn(
      { err: getErrorMessage(err) },
      'Failed to update .env with refreshed tokens',
    );
  }
}

async function refreshToken(
  refreshTokenStr: string,
  scopes: string[],
): Promise<TokenResponse> {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenStr,
    client_id: CLIENT_ID,
    scope: (scopes.length > 0 ? scopes : DEFAULT_SCOPES).join(' '),
  });

  const headers = { 'Content-Type': 'application/json' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.status === 200) {
      return (await res.json()) as TokenResponse;
    }

    const errText = await res.text().catch(() => '');
    logger.warn(
      { url: TOKEN_URL, status: res.status, body: errText.slice(0, 200) },
      'Token refresh failed at endpoint',
    );
  } catch (err) {
    logger.warn(
      { url: TOKEN_URL, err: getErrorMessage(err) },
      'Token refresh request error',
    );
  }

  throw new Error('Token refresh failed');
}

/**
 * Check and refresh a single account's credentials.
 * Returns the new access token if refreshed, null otherwise.
 */
async function checkAndRefreshAccount(
  accountIndex: number,
  opts?: { force?: boolean },
): Promise<string | null> {
  const creds = readCredentials(accountIndex);
  if (!creds?.claudeAiOauth) return null;

  const { expiresAt, refreshToken: rt } = creds.claudeAiOauth;
  if (!rt) {
    logger.debug({ accountIndex }, 'No refresh token in credentials, skipping');
    return null;
  }

  const now = Date.now();
  const remaining = expiresAt - now;

  if (!opts?.force && remaining > REFRESH_BEFORE_EXPIRY_MS) {
    logger.debug(
      { accountIndex, remainingMin: Math.round(remaining / 60000) },
      'Token still valid, no refresh needed',
    );
    return null;
  }

  const isExpired = remaining <= 0;
  logger.info(
    {
      accountIndex,
      remainingMin: Math.round(remaining / 60000),
      isExpired,
      force: opts?.force === true,
    },
    'Refreshing Claude OAuth token',
  );

  try {
    const response = await refreshToken(
      rt,
      creds.claudeAiOauth.scopes || DEFAULT_SCOPES,
    );

    creds.claudeAiOauth.accessToken = response.access_token;
    creds.claudeAiOauth.refreshToken = response.refresh_token || rt;
    creds.claudeAiOauth.expiresAt = now + response.expires_in * 1000;

    if (response.scope) {
      creds.claudeAiOauth.scopes = response.scope.split(' ');
    }

    writeCredentials(accountIndex, creds);

    const newExpiryMin = Math.round(response.expires_in / 60);
    logger.info(
      { accountIndex, expiresInMin: newExpiryMin },
      'Claude OAuth token refreshed successfully',
    );

    return response.access_token;
  } catch (err) {
    logger.error(
      {
        accountIndex,
        err: getErrorMessage(err),
      },
      'Failed to refresh Claude OAuth token — manual re-login may be required',
    );
    return null;
  }
}

/**
 * Check and refresh all accounts, updating token rotation and .env.
 */
async function checkAndRefreshAll(): Promise<void> {
  const allTokens = getAllTokens();
  const accountCount = Math.max(allTokens.length, 1);
  let anyRefreshed = false;

  for (let i = 0; i < accountCount; i++) {
    const newAccessToken = await checkAndRefreshAccount(i);
    if (newAccessToken && i < allTokens.length) {
      updateTokenValue(i, newAccessToken);
      anyRefreshed = true;
    }
  }

  if (anyRefreshed) {
    // Sync refreshed tokens to process.env so subsequent turns pick them up
    const refreshedTokens = getAllTokens();
    if (refreshedTokens.length > 0) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = refreshedTokens[0].token;
      if (refreshedTokens.length > 1) {
        process.env.CLAUDE_CODE_OAUTH_TOKENS = refreshedTokens
          .map((t) => t.token)
          .join(',');
      }
    }
    updateEnvTokens();
  }
}

let refreshInterval: ReturnType<typeof setInterval> | null = null;

export function startTokenRefreshLoop(): void {
  const allTokens = getAllTokens();

  // Check if any credentials files exist (for any configured account)
  const accountCount = Math.max(allTokens.length, 1);
  let hasAnyCreds = false;
  for (let i = 0; i < accountCount; i++) {
    const creds = readCredentials(i);
    if (creds?.claudeAiOauth) {
      hasAnyCreds = true;
      break;
    }
  }

  if (!hasAnyCreds) {
    logger.info('No OAuth credentials found, token refresh disabled');
    return;
  }

  logger.info(
    { checkIntervalMin: CHECK_INTERVAL_MS / 60000, accountCount },
    'Token auto-refresh started',
  );

  // Check immediately on startup
  checkAndRefreshAll().catch((err) =>
    logger.error({ err }, 'Initial token refresh check failed'),
  );

  refreshInterval = setInterval(() => {
    checkAndRefreshAll().catch((err) =>
      logger.error({ err }, 'Token refresh check failed'),
    );
  }, CHECK_INTERVAL_MS);
}

export function stopTokenRefreshLoop(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

/**
 * Force an immediate token refresh for a specific account index.
 * Useful when a 401 is detected — attempt refresh before giving up.
 * Returns the new access token if refresh succeeded, null otherwise.
 */
export async function forceRefreshToken(
  tokenIndex: number,
): Promise<string | null> {
  logger.info({ tokenIndex }, 'Force-refreshing token after 401');

  const newAccessToken = await checkAndRefreshAccount(tokenIndex, {
    force: true,
  });
  if (newAccessToken) {
    const allTokens = getAllTokens();
    if (tokenIndex < allTokens.length) {
      updateTokenValue(tokenIndex, newAccessToken);
      updateEnvTokens();
    }
  }
  return newAccessToken;
}
