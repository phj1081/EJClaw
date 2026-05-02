import fs from 'fs';
import path from 'path';

import {
  extractImageTagPaths,
  normalizeAgentOutput,
  type RunnerStructuredOutput,
  writeProtocolOutput,
} from 'ejclaw-runners-shared';

export interface RunnerOutput {
  status: 'success' | 'error';
  phase?: 'progress' | 'final' | 'tool-activity' | 'intermediate';
  agentId?: string;
  agentLabel?: string;
  agentDone?: boolean;
  result: string | null;
  output?: RunnerStructuredOutput;
  newSessionId?: string;
  error?: string;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        data: string;
      };
    };

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

interface AssistantContentBlock {
  type?: string;
  text?: string;
}

export type LogFn = (message: string) => void;
type StreamContent = string | ContentBlock[];

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function buildMultimodalContent(
  text: string,
  log: LogFn,
): StreamContent {
  const { cleanText, imagePaths } = extractImageTagPaths(text);
  if (imagePaths.length === 0) return text;

  const blocks: ContentBlock[] = [];
  if (cleanText) {
    blocks.push({ type: 'text', text: cleanText });
  }

  for (const imgPath of imagePaths) {
    try {
      if (!fs.existsSync(imgPath)) {
        log(`Image not found, skipping: ${imgPath}`);
        continue;
      }
      const data = fs.readFileSync(imgPath).toString('base64');
      const ext = path.extname(imgPath).toLowerCase();
      const mediaType = (MIME_TYPES[ext] || 'image/png') as
        | 'image/jpeg'
        | 'image/png'
        | 'image/gif'
        | 'image/webp';
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      });
      log(`Added image block: ${imgPath} (${mediaType})`);
    } catch (err) {
      log(
        `Failed to read image ${imgPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return blocks.length > 0 ? blocks : text;
}

export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  constructor(private readonly buildContent: (text: string) => StreamContent) {}

  push(text: string): void {
    const content = this.buildContent(text);
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
  }
}

export async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

export function writeOutput(output: RunnerOutput): void {
  writeProtocolOutput(output);
}

export function normalizeStructuredOutput(result: string | null): {
  result: string | null;
  output?: RunnerOutput['output'];
} {
  return normalizeAgentOutput(result);
}

export function extractAssistantText(message: unknown): string | null {
  const assistant = message as {
    message?: {
      content?: AssistantContentBlock[];
    };
  };
  const blocks = assistant.message?.content;
  if (!Array.isArray(blocks)) return null;

  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();

  return text || null;
}
