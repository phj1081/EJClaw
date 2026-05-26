import { rememberMemory } from '../db.js';
import { logger } from '../logger.js';
import type { TaskIpcPayload } from '../ipc-types.js';

type MemorySourceKind = Parameters<typeof rememberMemory>[0]['sourceKind'];

export function handlePersistMemory(
  data: TaskIpcPayload,
  sourceGroup: string,
): void {
  if (!hasPersistMemoryFields(data)) {
    logger.warn(
      { sourceGroup, data },
      'Invalid persist_memory request - missing required fields',
    );
    return;
  }

  const expectedScopeKey = `room:${sourceGroup}`;
  if (data.scopeKey !== expectedScopeKey) {
    logger.warn(
      { sourceGroup, scopeKey: data.scopeKey, expectedScopeKey },
      'Unauthorized persist_memory attempt blocked',
    );
    return;
  }

  if (!isMemorySourceKind(data.source_kind)) {
    logger.warn(
      { sourceGroup, sourceKind: data.source_kind },
      'Invalid persist_memory request - unknown source_kind',
    );
    return;
  }

  if (!hasValidKeywords(data.keywords)) {
    logger.warn(
      { sourceGroup, keywords: data.keywords },
      'Invalid persist_memory request - keywords must be strings',
    );
    return;
  }

  rememberMemory({
    scopeKind: 'room',
    scopeKey: data.scopeKey,
    content: data.content,
    keywords: data.keywords,
    memoryKind: typeof data.memory_kind === 'string' ? data.memory_kind : null,
    sourceKind: data.source_kind ?? 'compact',
    sourceRef: typeof data.source_ref === 'string' ? data.source_ref : null,
  });
  logger.info(
    {
      sourceGroup,
      scopeKey: data.scopeKey,
      sourceKind: data.source_kind ?? 'compact',
    },
    'Memory persisted via IPC',
  );
}

function hasPersistMemoryFields(
  data: TaskIpcPayload,
): data is TaskIpcPayload & {
  scopeKind: 'room';
  scopeKey: string;
  content: string;
} {
  return (
    data.scopeKind === 'room' &&
    typeof data.scopeKey === 'string' &&
    typeof data.content === 'string'
  );
}

function isMemorySourceKind(
  value: string | undefined,
): value is MemorySourceKind | undefined {
  return (
    value === undefined ||
    value === 'compact' ||
    value === 'explicit' ||
    value === 'import' ||
    value === 'system'
  );
}

function hasValidKeywords(
  value: TaskIpcPayload['keywords'],
): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}
