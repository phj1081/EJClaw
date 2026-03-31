export interface SelectedCompactMemory {
  content: string;
  keywords: string[];
  memoryKind: string | null;
}

const MAX_SELECTED_MEMORIES = 3;

const MEMORY_PATTERNS: Array<{
  kind: string | null;
  regex: RegExp;
  keyword: string;
}> = [
  { kind: 'room_norm', regex: /(규칙|원칙|금지|반드시|하지 않|세션 시작 시에만|새 세션 시작 시에만)/i, keyword: 'rule' },
  { kind: 'preference', regex: /(선호|원함|원한다|원하는|원했다)/i, keyword: 'preference' },
  { kind: 'decision', regex: /(합의|결정|방향|기준|우선|책임지는 방향)/i, keyword: 'decision' },
  { kind: 'project_fact', regex: /(owner|reviewer|trigger|모드|메모리|기억|세션 리셋|recall|persist|compact)/i, keyword: 'memory' },
];

function normalizeSentence(raw: string): string | null {
  const normalized = raw
    .trim()
    .replace(/^[-*]\s*/, '')
    .replace(/\s+/g, ' ');
  return normalized ? normalized : null;
}

function splitSummaryIntoSentences(summary: string): string[] {
  return summary
    .split(/\n+|(?<=[.!?。])\s+/)
    .map(normalizeSentence)
    .filter((value): value is string => Boolean(value));
}

function classifyMemorySentence(content: string): SelectedCompactMemory | null {
  if (!content) return null;

  const matchedPatterns = MEMORY_PATTERNS.filter(({ regex }) => regex.test(content));
  if (matchedPatterns.length === 0) return null;

  const primary = matchedPatterns[0];
  const keywords = [
    ...new Set(
      matchedPatterns
        .map((pattern) => pattern.keyword)
        .filter(Boolean),
    ),
  ];

  return {
    content,
    keywords,
    memoryKind: primary?.kind ?? null,
  };
}

export function selectCompactMemoriesFromSummary(
  summary: string,
  roomKey: string,
): SelectedCompactMemory[] {
  if (!summary.trim()) return [];

  const selected = splitSummaryIntoSentences(summary)
    .map((sentence) => classifyMemorySentence(sentence))
    .filter((value): value is SelectedCompactMemory => Boolean(value))
    .slice(0, MAX_SELECTED_MEMORIES)
    .map((entry) => ({
      ...entry,
      keywords: [...new Set([roomKey, ...entry.keywords])],
    }));

  return selected;
}
