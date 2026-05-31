import type { ArbiterVerdict } from './types.js';

export type VisibleVerdict =
  | 'step_done'
  | 'task_done'
  | 'done'
  | 'done_with_concerns'
  | 'blocked'
  | 'needs_context'
  | 'continue';

export type ArbiterVerdictResult = ArbiterVerdict | 'unknown';

const VISIBLE_VERDICT_SCAN_LINE_LIMIT = 12;
const ARBITER_VERDICT_SCAN_LINE_LIMIT = 12;

function leadingVisibleLines(text: string, limit: number): string[] {
  const lines: string[] = [];
  let inFence = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length === 0) {
      continue;
    }
    lines.push(line);
    if (lines.length >= limit) {
      break;
    }
  }

  return lines;
}

function stripInternalBlocks(text: string): string {
  return text.replace(/<internal>[\s\S]*?(?:<\/internal>|$)/g, '');
}

function parseVisibleVerdictLine(line: string): VisibleVerdict | null {
  if (/^\*{0,2}BLOCKED(?:\*{0,2})?\b/i.test(line)) return 'blocked';
  if (/^\*{0,2}NEEDS_CONTEXT(?:\*{0,2})?\b/i.test(line)) return 'needs_context';
  if (/^\*{0,2}STEP_DONE(?:\*{0,2})?\b/i.test(line)) return 'step_done';
  if (/^\*{0,2}TASK_DONE(?:\*{0,2})?\b/i.test(line)) return 'task_done';
  if (/^\*{0,2}DONE_WITH_CONCERNS(?:\*{0,2})?\b/i.test(line))
    return 'done_with_concerns';
  if (/^\*{0,2}DONE(?:\*{0,2})?\b/i.test(line)) return 'done';
  if (/^\*{0,2}Approved\.?(?:\*{0,2})?/i.test(line)) return 'done';
  if (/^\*{0,2}LGTM(?:\*{0,2})?/i.test(line)) return 'done';
  return null;
}

export function parseVisibleVerdict(
  summary: string | null | undefined,
): VisibleVerdict {
  if (!summary) return 'continue';
  const cleaned = stripInternalBlocks(summary).trim();
  if (!cleaned) return 'continue';
  for (const line of leadingVisibleLines(
    cleaned,
    VISIBLE_VERDICT_SCAN_LINE_LIMIT,
  )) {
    const verdict = parseVisibleVerdictLine(line);
    if (verdict) return verdict;
  }
  return 'continue';
}

export function classifyArbiterVerdict(
  summary: string | null | undefined,
): ArbiterVerdictResult {
  if (!summary) return 'unknown';
  const cleaned = stripInternalBlocks(summary).trim();
  if (!cleaned) return 'unknown';
  for (const line of leadingVisibleLines(
    cleaned,
    ARBITER_VERDICT_SCAN_LINE_LIMIT,
  )) {
    const verdictMatch = line.match(
      /\*{0,2}(?:VERDICT\s*[:—-]\s*)?(PROCEED|REVISE|RESET|ESCALATE|CONTINUE)\*{0,2}/i,
    );
    if (verdictMatch) {
      const normalized = verdictMatch[1].toLowerCase();
      return normalized === 'continue'
        ? 'proceed'
        : (normalized as ArbiterVerdict);
    }
  }
  return 'unknown';
}

export function resolveStoredVisibleVerdict(args: {
  verdict?: VisibleVerdict | null;
  outputText?: string | null;
}): VisibleVerdict | null {
  if (args.verdict) {
    return args.verdict;
  }
  if (!args.outputText) {
    return null;
  }
  return parseVisibleVerdict(args.outputText);
}
