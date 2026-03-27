import { randomBytes } from 'crypto';

import {
  CLAUDE_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  normalizeServiceId,
} from './config.js';

const ANY_SUPPRESS_TOKEN_PATTERN = /__EJ_SUPPRESS_[a-f0-9]{24,}(?:__)?/g;
const EXACT_ANY_SUPPRESS_TOKEN_PATTERN = /^__EJ_SUPPRESS_[a-f0-9]{24,}(?:__)?$/;

export function createSuppressToken(): string {
  return `__EJ_SUPPRESS_${randomBytes(12).toString('hex')}__`;
}

export function shouldEnableSuppressOutputForService(
  serviceId: string | undefined,
): boolean {
  if (!serviceId) return false;
  const normalized = normalizeServiceId(serviceId);
  return (
    normalized === CLAUDE_SERVICE_ID ||
    normalized === CODEX_REVIEW_SERVICE_ID
  );
}

export function classifySuppressTokenOutput(
  rawText: string,
  suppressToken: string | undefined,
): 'exact' | 'mixed' | 'none' {
  const trimmed = rawText.trim();
  if ((suppressToken && trimmed === suppressToken) || EXACT_ANY_SUPPRESS_TOKEN_PATTERN.test(trimmed)) {
    return 'exact';
  }
  if (suppressToken && rawText.includes(suppressToken)) {
    return 'mixed';
  }
  ANY_SUPPRESS_TOKEN_PATTERN.lastIndex = 0;
  return ANY_SUPPRESS_TOKEN_PATTERN.test(rawText) ? 'mixed' : 'none';
}

export function buildSuppressTokenPrompt(
  prompt: string,
  suppressToken: string | undefined,
  options?: {
    reviewerMode?: boolean;
  },
): string {
  if (!suppressToken) return prompt;

  const lines = [
    '[OUTPUT CONTROL]',
    `If you have no user-visible content to send for this turn, output exactly this token and nothing else: ${suppressToken}`,
    'Do not wrap the token in backticks or code fences.',
    'Do not combine the token with any other text.',
  ];

  if (options?.reviewerMode) {
    lines.push(
      'If you are only agreeing, mirroring, or restating without adding a concrete correction, risk, missing prerequisite, test gap, or code change, output only the token.',
    );
  }

  return `${lines.join('\n')}\n\n${prompt}`;
}
