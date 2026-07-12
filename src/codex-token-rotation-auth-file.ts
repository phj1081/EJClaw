import fs from 'fs';

export function readCodexAccessToken(authPath: string): string | null {
  return readCodexAuthTokens(authPath)?.accessToken ?? null;
}

/**
 * Read the access token plus the ChatGPT account id from auth.json.
 * The account id disambiguates multi-workspace tokens (e.g. team plans):
 * without the `chatgpt-account-id` header, wham/usage may answer for a
 * different workspace than the one Codex actually consumes.
 */
export function readCodexAuthTokens(
  authPath: string,
): { accessToken: string; accountId: string | null } | null {
  try {
    const data = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as {
      tokens?: { access_token?: unknown; account_id?: unknown };
    };
    const accessToken = data.tokens?.access_token;
    if (typeof accessToken !== 'string' || accessToken.trim() === '') {
      return null;
    }
    const accountId = data.tokens?.account_id;
    return {
      accessToken,
      accountId:
        typeof accountId === 'string' && accountId.trim() !== ''
          ? accountId
          : null,
    };
  } catch {
    return null;
  }
}

export function parseJwtAuth(idToken: string): {
  planType: string;
  expiresAt: string | null;
} {
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return { planType: '?', expiresAt: null };
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    );
    const auth = payload?.['https://api.openai.com/auth'] || {};
    return {
      planType: auth.chatgpt_plan_type || '?',
      expiresAt: auth.chatgpt_subscription_active_until || null,
    };
  } catch {
    return { planType: '?', expiresAt: null };
  }
}

export function readAuthFileMtimeMs(authPath: string): number {
  try {
    return fs.statSync(authPath).mtimeMs;
  } catch {
    return 0;
  }
}
