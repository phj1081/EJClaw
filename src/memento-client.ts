import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_PAGE_SIZE = 6;
const DEFAULT_TOKEN_BUDGET = 1_200;
const DEFAULT_MAX_BRIEFING_CHARS = 2_000;

interface MementoConfig {
  sseUrl: string;
  accessKey: string;
}

interface MementoContentBlock {
  type?: string;
  text?: string;
}

interface MementoCallToolResult {
  content?: MementoContentBlock[];
  isError?: boolean;
}

interface MementoRecallFragment {
  id: string;
  content: string;
  topic?: string;
  type?: string;
  importance?: number;
}

interface MementoRecallResponse {
  success?: boolean;
  fragments?: MementoRecallFragment[];
}

let cachedConfig: MementoConfig | null | undefined;

function getMementoConfig(): MementoConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const env = readEnvFile(['MEMENTO_MCP_SSE_URL', 'MEMENTO_ACCESS_KEY']);
  const sseUrl = process.env.MEMENTO_MCP_SSE_URL || env.MEMENTO_MCP_SSE_URL;
  const accessKey = process.env.MEMENTO_ACCESS_KEY || env.MEMENTO_ACCESS_KEY;

  cachedConfig =
    sseUrl && accessKey
      ? {
          sseUrl,
          accessKey,
        }
      : null;

  return cachedConfig;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function extractToolText(result: MementoCallToolResult): string | null {
  if (!Array.isArray(result.content)) return null;

  const text = result.content
    .filter(
      (block): block is MementoContentBlock & { text: string } =>
        block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();

  return text || null;
}

function parseToolJson<T>(
  result: MementoCallToolResult,
  toolName: string,
): T | null {
  const text = extractToolText(result);
  if (!text) return null;

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    logger.warn(
      { toolName, error, text },
      'Failed to parse Memento tool response JSON',
    );
    return null;
  }
}

async function callMementoTool<T>(
  name: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T | null> {
  const config = getMementoConfig();
  if (!config) return null;

  const transport = new SSEClientTransport(new URL(config.sseUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${config.accessKey}`,
      },
    },
  });
  const client = new Client({ name: 'ejclaw-host', version: '1.0.0' });

  try {
    await withTimeout(client.connect(transport), timeoutMs, `${name}/connect`);
    const result = await withTimeout(
      client.callTool({
        name,
        arguments: args,
      }) as Promise<MementoCallToolResult>,
      timeoutMs,
      `${name}/call`,
    );

    if (result.isError) {
      logger.warn({ toolName: name, args }, 'Memento tool returned an error');
      return null;
    }

    return parseToolJson<T>(result, name);
  } catch (error) {
    logger.warn({ toolName: name, args, error }, 'Memento tool call failed');
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

function trimToMaxChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

export function buildRoomMemoryKey(groupFolder: string): string {
  return `room:${groupFolder}`;
}

export function formatRoomMemoryBriefing(
  roomKey: string,
  fragments: MementoRecallFragment[],
  maxChars = DEFAULT_MAX_BRIEFING_CHARS,
): string | undefined {
  if (fragments.length === 0) return undefined;

  const lines = fragments
    .map((fragment) => {
      const meta = [fragment.type, fragment.topic].filter(Boolean).join(' / ');
      const prefix = meta ? `- [${meta}] ` : '- ';
      return `${prefix}${fragment.content.trim()}`;
    })
    .filter(Boolean);

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
  groupName: string;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<string | undefined> {
  const roomKey = buildRoomMemoryKey(args.groupFolder);
  const recallResponse = await callMementoTool<MementoRecallResponse>(
    'recall',
    {
      text: `shared room memory for ${args.groupName} (${roomKey})`,
      keywords: [roomKey],
      pageSize: DEFAULT_PAGE_SIZE,
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      includeLinks: false,
      excludeSeen: false,
    },
    args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!recallResponse?.success || !recallResponse.fragments?.length) {
    return undefined;
  }

  return formatRoomMemoryBriefing(
    roomKey,
    recallResponse.fragments,
    args.maxChars ?? DEFAULT_MAX_BRIEFING_CHARS,
  );
}
