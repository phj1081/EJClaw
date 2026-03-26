import { describe, expect, it } from 'vitest';

import {
  classifyAgentError,
  classifyClaudeAuthError,
  detectClaudeProviderFailureMessage,
  isClaudeOrgAccessDeniedMessage,
  isNoFallbackCooldownReason,
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

  it('marks only Claude quota/auth reasons as Claude rotation reasons', () => {
    expect(shouldRotateClaudeToken('429')).toBe(true);
    expect(shouldRotateClaudeToken('usage-exhausted')).toBe(true);
    expect(shouldRotateClaudeToken('auth-expired')).toBe(true);
    expect(shouldRotateClaudeToken('org-access-denied')).toBe(true);
    expect(shouldRotateClaudeToken('overloaded')).toBe(false);
    expect(shouldRotateClaudeToken('success-null-result')).toBe(false);
  });

  it('marks only no-fallback cooldown reasons as skip-worthy', () => {
    expect(isNoFallbackCooldownReason('usage-exhausted')).toBe(true);
    expect(isNoFallbackCooldownReason('auth-expired')).toBe(true);
    expect(isNoFallbackCooldownReason('org-access-denied')).toBe(true);
    expect(isNoFallbackCooldownReason('429')).toBe(false);
    expect(isNoFallbackCooldownReason('success-null-result')).toBe(false);
  });
});
