import { randomBytes } from 'crypto';

import {
  CLAUDE_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  normalizeServiceId,
} from './config.js';
import type { PairedGateTurnKind, StructuredAgentOutput } from './types.js';

const ANY_SUPPRESS_TOKEN_PATTERN = /__EJ_SUPPRESS_[a-f0-9]{24,}(?:__)?/g;
const EXACT_ANY_SUPPRESS_TOKEN_PATTERN = /^__EJ_SUPPRESS_[a-f0-9]{24,}(?:__)?$/;
const STRUCTURED_SILENT_OUTPUT_PREFIX_PATTERN =
  /^\s*\{\s*"ejclaw"\s*:\s*\{\s*"visibility"\s*:\s*"silent"/;
export const STRUCTURED_SILENT_OUTPUT_ENVELOPE =
  '{"ejclaw":{"visibility":"silent"}}';
const STRUCTURED_PUBLIC_VERDICTS = new Set([
  'done',
  'done_with_concerns',
  'blocked',
]);
const STRUCTURED_SILENT_VERDICTS = new Set(['silent']);

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
      ejclaw?: { visibility?: unknown; text?: unknown; verdict?: unknown };
    };
    const envelope = parsed?.ejclaw;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return null;
    }
    if (envelope.visibility === 'silent') {
      if (
        envelope.verdict !== undefined &&
        !STRUCTURED_SILENT_VERDICTS.has(String(envelope.verdict))
      ) {
        return null;
      }
      return {
        visibility: 'silent',
        verdict:
          envelope.verdict === 'silent'
            ? ('silent' as const)
            : undefined,
      };
    }
    if (
      envelope.visibility === 'public' &&
      typeof envelope.text === 'string' &&
      envelope.text.length > 0
    ) {
      if (
        envelope.verdict !== undefined &&
        !STRUCTURED_PUBLIC_VERDICTS.has(String(envelope.verdict))
      ) {
        return null;
      }
      return {
        visibility: 'public',
        text: envelope.text,
        verdict:
          typeof envelope.verdict === 'string'
            ? (envelope.verdict as 'done' | 'done_with_concerns' | 'blocked')
            : undefined,
      };
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
    gateTurnKind?: PairedGateTurnKind | null;
    requiresVisibleVerdict?: boolean;
  },
): string {
  const lines = [
    '[OUTPUT CONTROL]',
    `If you have no user-visible content to send for this turn, output exactly this JSON and nothing else: ${STRUCTURED_SILENT_OUTPUT_ENVELOPE}`,
    'Do not wrap the JSON in backticks or code fences.',
    'Do not combine the JSON with any other text.',
    'If you have already emitted any visible progress, status update, or partial answer earlier in this turn, do not end with the JSON object. Finish with a short visible final conclusion for the user instead.',
  ];

  if (options?.reviewerMode) {
    lines.push(
      'If you have not already emitted any visible progress, status update, or partial answer in this turn and you are only agreeing, mirroring, or restating without adding a concrete correction, risk, missing prerequisite, test gap, or code change, output only the JSON object.',
    );
  }

  if (options?.reviewerMode && options.requiresVisibleVerdict) {
    lines.push(
      `This turn is a paired-room gate turn for ${options.gateTurnKind ?? 'implementation_start'}. Silent output is forbidden.`,
    );
    lines.push(
      'Your final answer must be a structured public JSON envelope with a reviewer verdict: {"ejclaw":{"visibility":"public","verdict":"done","text":"**DONE** ..."}}',
    );
    lines.push(
      'Allowed verdict values are: "done", "done_with_concerns", "blocked".',
    );
  }

  return `${lines.join('\n')}\n\n${prompt}`;
}
