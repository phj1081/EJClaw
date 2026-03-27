import { randomBytes } from 'crypto';

import {
  CLAUDE_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  normalizeServiceId,
} from './config.js';
import type { StructuredAgentOutput } from './types.js';

const ANY_SUPPRESS_TOKEN_PATTERN = /__EJ_SUPPRESS_[a-f0-9]{24,}(?:__)?/g;
const EXACT_ANY_SUPPRESS_TOKEN_PATTERN = /^__EJ_SUPPRESS_[a-f0-9]{24,}(?:__)?$/;
const STRUCTURED_SILENT_OUTPUT_PREFIX_PATTERN =
  /^\s*\{\s*"ejclaw"\s*:\s*\{\s*"visibility"\s*:\s*"silent"/;
export const STRUCTURED_SILENT_OUTPUT_ENVELOPE =
  '{"ejclaw":{"visibility":"silent"}}';

export function createSuppressToken(): string {
  return `__EJ_SUPPRESS_${randomBytes(12).toString('hex')}__`;
}

export function shouldEnableSuppressOutputForService(
  serviceId: string | undefined,
): boolean {
  if (!serviceId) return false;
  const normalized = normalizeServiceId(serviceId);
  return (
    normalized === CLAUDE_SERVICE_ID || normalized === CODEX_REVIEW_SERVICE_ID
  );
}

export function classifySuppressTokenOutput(
  rawText: string,
  suppressToken: string | undefined,
): 'exact' | 'mixed' | 'none' {
  const trimmed = rawText.trim();
  const structured = parseStructuredOutputEnvelope(trimmed);
  if (
    (suppressToken && trimmed === suppressToken) ||
    EXACT_ANY_SUPPRESS_TOKEN_PATTERN.test(trimmed) ||
    structured?.visibility === 'silent'
  ) {
    return 'exact';
  }
  if (suppressToken && rawText.includes(suppressToken)) {
    return 'mixed';
  }
  ANY_SUPPRESS_TOKEN_PATTERN.lastIndex = 0;
  if (ANY_SUPPRESS_TOKEN_PATTERN.test(rawText)) {
    return 'mixed';
  }
  return STRUCTURED_SILENT_OUTPUT_PREFIX_PATTERN.test(trimmed)
    ? 'mixed'
    : 'none';
}

export function parseStructuredOutputEnvelope(
  rawText: string,
): StructuredAgentOutput | null {
  try {
    const parsed = JSON.parse(rawText) as {
      ejclaw?: { visibility?: unknown; text?: unknown };
    };
    const envelope = parsed?.ejclaw;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return null;
    }
    if (envelope.visibility === 'silent') {
      return { visibility: 'silent' };
    }
    if (
      envelope.visibility === 'public' &&
      typeof envelope.text === 'string' &&
      envelope.text.length > 0
    ) {
      return { visibility: 'public', text: envelope.text };
    }
  } catch {
    return null;
  }

  return null;
}

export function buildStructuredOutputPrompt(
  prompt: string,
  options?: {
    reviewerMode?: boolean;
  },
): string {
  const lines = [
    '[OUTPUT CONTROL]',
    `If you have no user-visible content to send for this turn, output exactly this JSON and nothing else: ${STRUCTURED_SILENT_OUTPUT_ENVELOPE}`,
    'Do not wrap the JSON in backticks or code fences.',
    'Do not combine the JSON with any other text.',
  ];

  if (options?.reviewerMode) {
    lines.push(
      'If you are only agreeing, mirroring, or restating without adding a concrete correction, risk, missing prerequisite, test gap, or code change, output only the JSON object.',
    );
  }

  return `${lines.join('\n')}\n\n${prompt}`;
}
