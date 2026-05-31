import fs from 'fs';
import path from 'path';

import {
  attachmentEvidenceCaption,
  expandPromptAttachmentReferences,
  missingAttachmentCaption,
  normalizeAgentOutput,
  splitPromptAttachmentParts,
  type PromptAttachmentPart,
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
  compaction?: {
    completed: boolean;
    trigger?: string | null;
  };
}

export type RunnerCompaction = NonNullable<RunnerOutput['compaction']>;

export function buildCompactionOutput(
  compaction: RunnerCompaction | undefined,
): Pick<RunnerOutput, 'compaction'> {
  return compaction ? { compaction } : {};
}

export function compactBoundaryOutput(
  trigger: string | null | undefined,
): RunnerCompaction {
  return { completed: true, trigger: trigger || null };
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
    }
  | {
      type: 'document';
      title?: string | null;
      source:
        | {
            type: 'base64';
            media_type: 'application/pdf';
            data: string;
          }
        | {
            type: 'text';
            media_type: 'text/plain';
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

const TEXT_DOCUMENT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
  '.log',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
]);

function loadDocumentBlock(
  part: Extract<PromptAttachmentPart, { type: 'attachment' }>,
  log: LogFn,
): ContentBlock | string {
  try {
    if (!fs.existsSync(part.path)) {
      log(`Document not found, skipping: ${part.path}`);
      return missingAttachmentCaption(part, 'file not found');
    }

    const ext = path.extname(part.path).toLowerCase();
    if (ext === '.pdf') {
      const data = fs.readFileSync(part.path).toString('base64');
      log(`Added document block: ${part.path} (application/pdf)`);
      return {
        type: 'document',
        title: part.label ?? path.basename(part.path),
        source: { type: 'base64', media_type: 'application/pdf', data },
      };
    }

    if (TEXT_DOCUMENT_EXTENSIONS.has(ext)) {
      const data = fs.readFileSync(part.path, 'utf8');
      log(`Added document block: ${part.path} (text/plain)`);
      return {
        type: 'document',
        title: part.label ?? path.basename(part.path),
        source: { type: 'text', media_type: 'text/plain', data },
      };
    }

    log(`Unsupported document type, skipping: ${part.path}`);
    return missingAttachmentCaption(
      part,
      `unsupported document type ${ext || 'unknown'}`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`Failed to read document ${part.path}: ${reason}`);
    return missingAttachmentCaption(part, `read failed: ${reason}`);
  }
}

export function buildMultimodalContent(
  text: string,
  log: LogFn,
): StreamContent {
  const expandedText = expandPromptAttachmentReferences(text);
  const parts = splitPromptAttachmentParts(expandedText);
  if (!parts.some((part) => part.type === 'attachment')) return text;

  const blocks: ContentBlock[] = [];
  const pushText = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) blocks.push({ type: 'text', text: trimmed });
  };

  for (const part of parts) {
    if (part.type === 'text') {
      pushText(part.text);
      continue;
    }

    if (part.kind === 'document') {
      pushText(attachmentEvidenceCaption(part));
      const block = loadDocumentBlock(part, log);
      if (typeof block === 'string') {
        pushText(block);
      } else {
        blocks.push(block);
      }
      continue;
    }

    if (part.kind !== 'image') {
      pushText(part.raw);
      continue;
    }

    try {
      if (!fs.existsSync(part.path)) {
        log(`Image not found, skipping: ${part.path}`);
        pushText(missingAttachmentCaption(part, 'file not found'));
        continue;
      }
      const ext = path.extname(part.path).toLowerCase();
      const mediaType = MIME_TYPES[ext] as
        | 'image/jpeg'
        | 'image/png'
        | 'image/gif'
        | 'image/webp'
        | undefined;
      if (!mediaType) {
        log(`Unsupported image type, skipping: ${part.path}`);
        pushText(
          missingAttachmentCaption(
            part,
            `unsupported image type ${ext || 'unknown'}`,
          ),
        );
        continue;
      }
      const data = fs.readFileSync(part.path).toString('base64');
      pushText(attachmentEvidenceCaption(part));
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data },
      });
      log(`Added image block: ${part.path} (${mediaType})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`Failed to read image ${part.path}: ${reason}`);
      pushText(missingAttachmentCaption(part, `read failed: ${reason}`));
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
