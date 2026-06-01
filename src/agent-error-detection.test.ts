import { describe, expect, it } from 'vitest';

import {
  classifyAgentError,
  classifyClaudeAuthError,
  classifyCodexAuthError,
  detectClaudeProviderFailureMessage,
  isClaudeOrgAccessDeniedMessage,
  shouldRotateClaudeToken,
} from './agent-error-detection.js';

describe('agent-error-detection', () => {
  it('detects Claude org access denied banners', () => {
    expect(
      isClaudeOrgAccessDeniedMessage(
        'Your organization does not have access to Claude. Please login again or contact your administrator.',
      ),
    ).toBe(true);
  });

  it('classifies org access denied banners as org-access-denied', () => {
    expect(
      classifyClaudeAuthError(
        'Your organization does not have access to Claude. Please login again or contact your administrator.',
      ),
    ).toEqual({
      category: 'org-access-denied',
      reason: 'org-access-denied',
    });
  });

  it('classifies terminated 403 auth failures as org-access-denied', () => {
    expect(
      classifyClaudeAuthError(
        'Failed to authenticate. API Error: 403 terminated',
      ),
    ).toEqual({
      category: 'org-access-denied',
      reason: 'org-access-denied',
    });
  });

  it('classifies Cloudflare 502 HTML as overloaded', () => {
    const message = `API Error: 502 <html>
<head><title>502 Bad Gateway</title></head>
<body>
<center><h1>502 Bad Gateway</h1></center>
<hr><center>cloudflare</center>
</body>
</html>`;

    expect(classifyAgentError(message)).toEqual({
      category: 'overloaded',
      reason: 'overloaded',
    });
    expect(detectClaudeProviderFailureMessage(message)).toBe('overloaded');
  });

  it('classifies Codex model capacity errors as overloaded', () => {
    expect(
      classifyAgentError(
        'Selected model is at capacity. Please try a different model.',
      ),
    ).toEqual({
      category: 'overloaded',
      reason: 'overloaded',
    });
  });

  it('classifies Codex reused refresh-token errors as auth-expired', () => {
    expect(
      classifyCodexAuthError(
        'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
      ),
    ).toEqual({
      category: 'auth-expired',
      reason: 'auth-expired',
    });
  });

  it('classifies a Codex auth-expired trigger reason as auth-expired', () => {
    expect(classifyCodexAuthError('auth-expired')).toEqual({
      category: 'auth-expired',
      reason: 'auth-expired',
    });
  });

  it('does not classify the internal Codex pool-unavailable sentinel as an auth failure', () => {
    expect(
      classifyCodexAuthError(
        'auth-expired: All Codex rotation accounts unavailable; re-auth required before launching Codex',
      ),
    ).toEqual({ category: 'none', reason: '' });
    expect(
      classifyCodexAuthError(
        'Codex rotation pool unavailable: all rotation accounts are currently dead, rate-limited, or locked',
      ),
    ).toEqual({ category: 'none', reason: '' });
  });

  it('classifies Codex workspace credit exhaustion as rate-limit', () => {
    expect(classifyAgentError('Workspace out of credits')).toEqual({
      category: 'rate-limit',
      reason: '429',
      retryAfterMs: undefined,
    });
  });

  it('marks only Claude quota/auth reasons as Claude rotation reasons', () => {
    expect(shouldRotateClaudeToken('429')).toBe(true);
    expect(shouldRotateClaudeToken('usage-exhausted')).toBe(true);
    expect(shouldRotateClaudeToken('auth-expired')).toBe(true);
    expect(shouldRotateClaudeToken('org-access-denied')).toBe(true);
    expect(shouldRotateClaudeToken('overloaded')).toBe(false);
    expect(shouldRotateClaudeToken('success-null-result')).toBe(false);
  });
});
