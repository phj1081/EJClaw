export type VisibleVerdict =
  | 'step_done'
  | 'task_done'
  | 'done'
  | 'done_with_concerns'
  | 'blocked'
  | 'needs_context'
  | 'continue';

export function parseVisibleVerdict(
  summary: string | null | undefined,
): VisibleVerdict {
  if (!summary) return 'continue';
  const cleaned = summary.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
  if (!cleaned) return 'continue';
  const firstLine = cleaned.split('\n')[0].trim();
  if (/^\*{0,2}BLOCKED\*{0,2}\b/i.test(firstLine)) return 'blocked';
  if (/^\*{0,2}NEEDS_CONTEXT\*{0,2}\b/i.test(firstLine))
    return 'needs_context';
  if (/^\*{0,2}STEP_DONE\*{0,2}\b/i.test(firstLine)) return 'step_done';
  if (/^\*{0,2}TASK_DONE\*{0,2}\b/i.test(firstLine)) return 'task_done';
  if (/^\*{0,2}DONE_WITH_CONCERNS\*{0,2}\b/i.test(firstLine))
    return 'done_with_concerns';
  if (/^\*{0,2}DONE\*{0,2}\b/i.test(firstLine)) return 'done';
  if (/^\*{0,2}Approved\.?\*{0,2}/i.test(firstLine)) return 'done';
  if (/^\*{0,2}LGTM\*{0,2}/i.test(firstLine)) return 'done';
  return 'continue';
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
