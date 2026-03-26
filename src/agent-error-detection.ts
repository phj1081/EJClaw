/**
 * Agent Error Detection (SSOT)
 *
 * Single source of truth for classifying agent errors from output text
 * and error strings. Used by both message-agent-executor and task-scheduler.
 */

// ── Banner / text detection ─────────────────────────────────────

export function isClaudeAuthError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('failed to authenticate') &&
    (lower.includes('401') || lower.includes('authentication_error'))
  );
}

export function isClaudeUsageExhaustedMessage(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/['\u2018\u2019`]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^error:\s*/i, '');
  const looksLikeBanner =
    normalized.startsWith("you're out of extra usage") ||
    normalized.startsWith('you are out of extra usage') ||
    normalized.startsWith("you've hit your limit") ||
    normalized.startsWith('you have hit your limit');
  const hasResetHint =
    normalized.includes('resets ') ||
    normalized.includes('reset at ') ||
    normalized.includes('try again');
  return looksLikeBanner && hasResetHint && normalized.length <= 160;
}

export function isClaudeAuthExpiredMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const looksLikeAuthFailure = normalized.startsWith('failed to authenticate');
  const hasExpiredTokenMarker =
    normalized.includes('oauth token has expired') ||
    normalized.includes('authentication_error') ||
    normalized.includes('obtain a new token') ||
    normalized.includes('refresh your existing token') ||
    normalized.includes('invalid authentication credentials');
  const hasUnauthorizedMarker =
    normalized.includes('401') || normalized.includes('authentication error');
  const hasTerminatedMarker = normalized.includes('terminated');

  return (
    looksLikeAuthFailure &&
    hasUnauthorizedMarker &&
    (hasExpiredTokenMarker || hasTerminatedMarker)
  );
}

export function detectClaudeProviderFailureMessage(
  text: string,
): Extract<AgentTriggerReason, '429' | 'overloaded' | 'network-error'> | '' {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const looksLikeProviderError =
    normalized.startsWith('api error:') ||
    normalized.startsWith('error: api error:') ||
    normalized.startsWith('network error') ||
    normalized.startsWith('fetch failed');

  if (!looksLikeProviderError) {
    return '';
  }

  const classification = classifyAgentError(text);
  if (
    classification.category === 'rate-limit' ||
    classification.category === 'overloaded' ||
    classification.category === 'network-error'
  ) {
    return classification.reason;
  }

  return '';
}

export function isClaudeOrgAccessDeniedMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const hasOrgAccessDeniedMarker = normalized.includes(
    'does not have access to claude',
  );
  const hasRecoveryHint =
    normalized.includes('please login again') ||
    normalized.includes('contact your administrator');

  return hasOrgAccessDeniedMarker && hasRecoveryHint;
}

// ── Rotation decision ───────────────────────────────────────────

export type AgentTriggerReason =
  | '429'
  | 'usage-exhausted'
  | 'auth-expired'
  | 'org-access-denied'
  | 'overloaded'
  | 'network-error'
  | 'success-null-result';

export type FallbackTriggerReason = Exclude<
  AgentTriggerReason,
  'usage-exhausted' | 'success-null-result'
>;

export type ClaudeRotationReason = Extract<
  AgentTriggerReason,
  '429' | 'usage-exhausted' | 'auth-expired' | 'org-access-denied'
>;

export type CodexRotationReason = FallbackTriggerReason;

export type NoFallbackCooldownReason = Extract<
  AgentTriggerReason,
  'usage-exhausted' | 'auth-expired' | 'org-access-denied'
>;

export function shouldRotateClaudeToken(
  reason: AgentTriggerReason,
): reason is ClaudeRotationReason {
  return (
    reason === '429' ||
    reason === 'usage-exhausted' ||
    reason === 'auth-expired' ||
    reason === 'org-access-denied'
  );
}

export function isNoFallbackCooldownReason(
  reason: AgentTriggerReason,
): reason is NoFallbackCooldownReason {
  return (
    reason === 'usage-exhausted' ||
    reason === 'auth-expired' ||
    reason === 'org-access-denied'
  );
}

// ── Unified error classification ────────────────────────────────

export type ErrorCategory =
  | 'rate-limit'
  | 'auth-expired'
  | 'org-access-denied'
  | 'overloaded'
  | 'network-error'
  | 'none';

export type AgentErrorClassification =
  | {
      category: 'none';
      reason: '';
      retryAfterMs?: undefined;
    }
  | {
      category: 'rate-limit';
      reason: '429';
      retryAfterMs?: number;
    }
  | {
      category: 'auth-expired';
      reason: 'auth-expired';
      retryAfterMs?: undefined;
    }
  | {
      category: 'org-access-denied';
      reason: 'org-access-denied';
      retryAfterMs?: undefined;
    }
  | {
      category: 'overloaded';
      reason: 'overloaded';
      retryAfterMs?: undefined;
    }
  | {
      category: 'network-error';
      reason: 'network-error';
      retryAfterMs?: undefined;
    };

const NONE: AgentErrorClassification = {
  category: 'none',
  reason: '',
};

/**
 * Classify an agent error string into a category.
 * Handles patterns common to both Claude and Codex: 429, 503, network.
 * Auth errors are provider-specific — use classifyClaudeAuthError or
 * classifyCodexAuthError for those.
 */
export function classifyAgentError(
  error: string | null | undefined,
): AgentErrorClassification {
  if (!error) return NONE;

  const lower = error.toLowerCase();

  // 429 / Rate Limit
  if (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('usage limit') ||
    lower.includes('hit your limit') ||
    lower.includes('too many requests') ||
    lower.includes('rate_limit')
  ) {
    const retryMatch = error.match(/retry[\s_-]*after[:\s]*(\d+)/i);
    const retryAfterMs = retryMatch
      ? parseInt(retryMatch[1], 10) * 1000
      : undefined;
    return { category: 'rate-limit', reason: '429', retryAfterMs };
  }

  // 503 / Overloaded
  if (
    lower.includes('503') ||
    lower.includes('overloaded') ||
    ((lower.includes('502') || lower.includes('bad gateway')) &&
      (lower.includes('cloudflare') ||
        lower.includes('<html') ||
        lower.includes('api error')))
  ) {
    return { category: 'overloaded', reason: 'overloaded' };
  }

  // Network / connection errors
  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('network error')
  ) {
    return { category: 'network-error', reason: 'network-error' };
  }

  return NONE;
}

// ── Provider-specific auth checks ───────────────────────────────

/** Claude auth: strict 3-condition AND (auth failure + 401 + specific marker). */
export function classifyClaudeAuthError(
  error: string | null | undefined,
): AgentErrorClassification {
  if (!error) return NONE;
  const lower = error.toLowerCase();

  const hasOrgAccessDeniedMarker =
    lower.includes('your organization does not have access to claude') ||
    (lower.includes('does not have access to claude') &&
      lower.includes('contact your administrator'));
  const hasTerminated403AuthFailure =
    lower.includes('failed to authenticate') &&
    lower.includes('403') &&
    lower.includes('terminated');

  if (hasOrgAccessDeniedMarker || hasTerminated403AuthFailure) {
    return { category: 'org-access-denied', reason: 'org-access-denied' };
  }

  if (
    (lower.includes('failed to authenticate') ||
      lower.includes('authentication_error')) &&
    (lower.includes('401') || lower.includes('unauthorized')) &&
    (lower.includes('oauth token has expired') ||
      lower.includes('obtain a new token') ||
      lower.includes('refresh your existing token') ||
      lower.includes('invalid authentication credentials') ||
      lower.includes('terminated'))
  ) {
    return { category: 'auth-expired', reason: 'auth-expired' };
  }

  return NONE;
}

/** Codex auth: loose OR check (any single auth indicator). */
export function classifyCodexAuthError(
  error: string | null | undefined,
): AgentErrorClassification {
  if (!error) return NONE;
  const lower = error.toLowerCase();

  if (
    lower.includes('401') ||
    lower.includes('authentication_error') ||
    lower.includes('failed to authenticate') ||
    lower.includes('oauth token has expired') ||
    lower.includes('refresh your existing token') ||
    lower.includes('unauthorized')
  ) {
    return { category: 'auth-expired', reason: 'auth-expired' };
  }

  return NONE;
}
