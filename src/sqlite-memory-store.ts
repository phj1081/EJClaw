import { type MemoryRecord, recallMemories } from './db.js';

const DEFAULT_PAGE_SIZE = 6;
const DEFAULT_MAX_BRIEFING_CHARS = 2_000;

function trimToMaxChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

export function buildRoomMemoryKey(groupFolder: string): string {
  return `room:${groupFolder}`;
}

export function formatRoomMemoryBriefing(
  roomKey: string,
  memories: MemoryRecord[],
  maxChars = DEFAULT_MAX_BRIEFING_CHARS,
): string | undefined {
  if (memories.length === 0) return undefined;

  const lines = memories
    .map((memory) => {
      const content = memory.content.trim();
      if (!content) return null;
      const prefix = memory.memoryKind ? `- [${memory.memoryKind}] ` : '- ';
      return `${prefix}${content}`;
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) return undefined;

  const text = [
    '## Shared Room Memory',
    `Room key: \`${roomKey}\``,
    'Treat this as background context for a fresh session start. The current conversation always takes precedence.',
    ...lines,
  ].join('\n');

  return trimToMaxChars(text, maxChars);
}

export async function buildRoomMemoryBriefing(args: {
  groupFolder: string;
  groupName?: string;
  maxChars?: number;
  limit?: number;
}): Promise<string | undefined> {
  void args.groupName;
  const roomKey = buildRoomMemoryKey(args.groupFolder);
  const memories = recallMemories({
    scopeKind: 'room',
    scopeKey: roomKey,
    limit: args.limit ?? DEFAULT_PAGE_SIZE,
  });

  return formatRoomMemoryBriefing(
    roomKey,
    memories,
    args.maxChars ?? DEFAULT_MAX_BRIEFING_CHARS,
  );
}
