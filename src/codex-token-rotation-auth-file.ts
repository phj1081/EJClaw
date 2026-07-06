import fs from 'fs';

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
