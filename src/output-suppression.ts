/**
 * Output suppression was removed — harness-level protections (isOwnMessage filter,
 * shouldSkipBotOnlyCollaboration, PAIRED_MAX_ROUND_TRIPS) now prevent infinite loops.
 *
 * Retained exports are stubs so callers compile without changes.
 */

export function createSuppressToken(): string | undefined {
  return undefined;
}

export function classifySuppressTokenOutput(
  _rawText: string,
  _suppressToken: string | undefined,
): 'none' {
  return 'none';
}

export function buildStructuredOutputPrompt(
  prompt: string,
  _options?: {
    reviewerMode?: boolean;
    pairedRoom?: boolean;
    gateTurnKind?: string | null;
    requiresVisibleVerdict?: boolean;
  },
): string {
  return prompt;
}

export function parseStructuredOutputEnvelope(
  _rawText: string,
): null {
  return null;
}
