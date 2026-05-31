export const OUTPUT_START_MARKER = '---EJCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---EJCLAW_OUTPUT_END---';

export const IMAGE_TAG_RE =
  /\[Image:\s*(?:(?:[^\]\n]*?)\s*→\s*)?(\/[^\]\n]+)\]/g;
const IMAGE_TAG_SEGMENT_RE = /\[Image:\s*(?:(.*?)\s*→\s*)?(\/[^\]\n]+)\]/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MARKDOWN_IMAGE_ABSOLUTE_LINK_RE = /!\[[^\]\n]*\]\((\/[^)\n]+)\)/g;
const MEDIA_TAG_RE =
  /^[ \t]*MEDIA:\s*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|(\/\S+))[ \t]*$/gm;

export const IPC_POLL_MS = 500;
export const IPC_INPUT_SUBDIR = 'input';
export const IPC_CLOSE_SENTINEL = '_close';

export type RunnerOutputPhase =
  | 'progress'
  | 'final'
  | 'tool-activity'
  | 'intermediate';

export type RunnerOutputVerdict =
  | 'done'
  | 'done_with_concerns'
  | 'blocked'
  | 'in_progress'
  | 'silent';

export type RunnerOutputVisibility = 'public' | 'silent';

export interface RunnerOutputAttachment {
  path: string;
  name?: string;
  mime?: string;
}

export type RunnerStructuredOutput =
  | {
      visibility: 'public';
      text: string;
      verdict?: Exclude<RunnerOutputVerdict, 'silent'>;
      attachments?: RunnerOutputAttachment[];
    }
  | {
      visibility: 'silent';
      verdict?: 'silent';
    };

export interface NormalizedRunnerOutput {
  result: string | null;
  output?: RunnerStructuredOutput;
  attachmentSource?:
    | 'legacy-ejclaw-json'
    | 'media-tag'
    | 'markdown-image'
    | 'image-tag'
    | 'mixed'
    | 'none';
}

export type NormalizedAgentOutput = NormalizedRunnerOutput;

function cloneImageTagPattern(): RegExp {
  return new RegExp(IMAGE_TAG_RE.source, IMAGE_TAG_RE.flags);
}

function cloneImageTagSegmentPattern(): RegExp {
  return new RegExp(IMAGE_TAG_SEGMENT_RE.source, IMAGE_TAG_SEGMENT_RE.flags);
}

export function writeProtocolOutput<T>(
  output: T,
  writeLine: (line: string) => void = console.log,
): void {
  writeLine(OUTPUT_START_MARKER);
  writeLine(JSON.stringify(output));
  writeLine(OUTPUT_END_MARKER);
}

export function extractImageTagPaths(text: string): {
  cleanText: string;
  imagePaths: string[];
} {
  const imagePattern = cloneImageTagPattern();
  const imagePaths = [...text.matchAll(imagePattern)].map((match) =>
    match[1].trim(),
  );

  return {
    cleanText: text.replace(cloneImageTagPattern(), '').trim(),
    imagePaths,
  };
}

export function expandImagePromptReferences(text: string): string {
  const codeSpans = fencedCodeSpans(text);
  const withMediaImages = text.replace(
    MEDIA_TAG_RE,
    (full: string, doubleQuoted, singleQuoted, backticked, bare, offset) => {
      if (isInsideSpans(offset, codeSpans)) return full;
      const filePath = String(
        doubleQuoted ?? singleQuoted ?? backticked ?? bare ?? '',
      ).trim();
      if (!filePath.startsWith('/') || !IMAGE_EXT_RE.test(filePath)) {
        return full;
      }
      const name = attachmentName(filePath) ?? filePath;
      return `[Image: ${name} → ${filePath}]`;
    },
  );

  const markdownCodeSpans = fencedCodeSpans(withMediaImages);
  return withMediaImages.replace(
    MARKDOWN_IMAGE_ABSOLUTE_LINK_RE,
    (full: string, rawPath: string, offset: number) => {
      if (isInsideSpans(offset, markdownCodeSpans)) return full;
      const filePath = rawPath.trim();
      if (!IMAGE_EXT_RE.test(filePath)) return full;
      const name = attachmentName(filePath) ?? filePath;
      return `[Image: ${name} → ${filePath}]`;
    },
  );
}

export type ImageTagPromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; label: string | null; path: string; raw: string };

export function splitImageTagPromptParts(text: string): ImageTagPromptPart[] {
  const imagePattern = cloneImageTagSegmentPattern();
  const parts: ImageTagPromptPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(imagePattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      parts.push({ type: 'text', text: text.slice(cursor, start) });
    }

    const raw = match[0];
    const label = match[1]?.trim() || null;
    const imagePath = match[2].trim();
    parts.push({ type: 'image', label, path: imagePath, raw });
    cursor = start + raw.length;
  }

  if (cursor < text.length) {
    parts.push({ type: 'text', text: text.slice(cursor) });
  }

  return parts.length > 0 ? parts : [{ type: 'text', text }];
}

export function imageTagCaption(
  part: Extract<ImageTagPromptPart, { type: 'image' }>,
): string {
  return part.label
    ? `Image evidence: ${part.label}`
    : `Image evidence: ${part.path}`;
}

export function missingImageTagCaption(
  part: Extract<ImageTagPromptPart, { type: 'image' }>,
  reason: string,
): string {
  const label = part.label ? `${part.label} → ` : '';
  return `[Image unavailable: ${label}${part.path} — ${reason}]`;
}

function attachmentName(filePath: string): string | undefined {
  return filePath.split(/[\\/]/).at(-1) || undefined;
}

function uniqueAttachments(
  attachments: RunnerOutputAttachment[],
): RunnerOutputAttachment[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    if (seen.has(attachment.path)) return false;
    seen.add(attachment.path);
    return true;
  });
}

export function extractMarkdownImageAttachments(text: string): {
  cleanText: string;
  attachments: RunnerOutputAttachment[];
} {
  const attachments: RunnerOutputAttachment[] = [];
  const cleanText = text.replace(
    MARKDOWN_IMAGE_ABSOLUTE_LINK_RE,
    (full: string, rawPath: string) => {
      const trimmed = rawPath.trim();
      if (!IMAGE_EXT_RE.test(trimmed)) return full;

      attachments.push({
        path: trimmed,
        name: attachmentName(trimmed),
      });
      return '';
    },
  );

  return {
    cleanText: cleanText.trim(),
    attachments: uniqueAttachments(attachments),
  };
}

function fencedCodeSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(/```[\s\S]*?```/g)].map((match) => [
    match.index ?? 0,
    (match.index ?? 0) + match[0].length,
  ]);
}

function isInsideSpans(index: number, spans: Array<[number, number]>): boolean {
  return spans.some(([start, end]) => index >= start && index < end);
}

function mediaMime(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.txt')) return 'text/plain';
  return undefined;
}

export function extractMediaAttachments(text: string): {
  cleanText: string;
  attachments: RunnerOutputAttachment[];
} {
  const codeSpans = fencedCodeSpans(text);
  const attachments: RunnerOutputAttachment[] = [];
  const cleanText = text.replace(
    MEDIA_TAG_RE,
    (full: string, doubleQuoted, singleQuoted, backticked, bare, offset) => {
      if (isInsideSpans(offset, codeSpans)) return full;
      const filePath = String(
        doubleQuoted ?? singleQuoted ?? backticked ?? bare ?? '',
      ).trim();
      if (!filePath.startsWith('/')) return full;
      const mime = mediaMime(filePath);
      attachments.push({
        path: filePath,
        name: attachmentName(filePath),
        ...(mime ? { mime } : {}),
      });
      return '';
    },
  );

  return {
    cleanText: cleanText.trim(),
    attachments: uniqueAttachments(attachments),
  };
}

function imageTagPathsToAttachments(
  imagePaths: string[],
): RunnerOutputAttachment[] {
  return uniqueAttachments(
    imagePaths
      .filter((filePath) => IMAGE_EXT_RE.test(filePath))
      .map((filePath) => ({
        path: filePath,
        name: attachmentName(filePath),
      })),
  );
}

export function normalizePublicTextOutput(
  result: string | null,
): NormalizedRunnerOutput {
  if (typeof result !== 'string' || result.length === 0) {
    return { result };
  }

  return {
    result,
    output: {
      visibility: 'public',
      text: result,
    },
  };
}

function isVisibleVerdict(
  value: unknown,
): value is Exclude<RunnerOutputVerdict, 'silent'> {
  return (
    value === 'done' ||
    value === 'done_with_concerns' ||
    value === 'blocked' ||
    value === 'in_progress'
  );
}

const LEADING_STRUCTURED_OUTPUT_CONTROL_RE =
  /^[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]+/u;
const STRUCTURED_STATUS_PREFIX_RE =
  /^(STEP_DONE|TASK_DONE|DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT)[ \t]*(?:\r?\n)+([\s\S]+)$/;

function stripLeadingStructuredOutputControls(value: string): string {
  return value.replace(LEADING_STRUCTURED_OUTPUT_CONTROL_RE, '').trimStart();
}

function normalizeAttachments(value: unknown): RunnerOutputAttachment[] {
  if (!Array.isArray(value)) return [];

  const attachments: RunnerOutputAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = item as {
      path?: unknown;
      name?: unknown;
      mime?: unknown;
    };
    if (typeof candidate.path !== 'string' || candidate.path.length === 0) {
      continue;
    }
    attachments.push({
      path: candidate.path,
      ...(typeof candidate.name === 'string' && candidate.name.length > 0
        ? { name: candidate.name }
        : {}),
      ...(typeof candidate.mime === 'string' && candidate.mime.length > 0
        ? { mime: candidate.mime }
        : {}),
    });
  }
  return attachments;
}

function extractStructuredJsonCandidate(trimmed: string): string {
  const fencedJson = trimmed.match(
    /^```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/,
  );
  return fencedJson?.[1]?.trim() ?? trimmed;
}

function extractStructuredCandidateWithOptionalStatus(trimmed: string): {
  jsonCandidate: string;
  statusPrefix: string | null;
} {
  const statusMatch = trimmed.match(STRUCTURED_STATUS_PREFIX_RE);
  if (!statusMatch) {
    return {
      jsonCandidate: extractStructuredJsonCandidate(trimmed),
      statusPrefix: null,
    };
  }

  return {
    jsonCandidate: extractStructuredJsonCandidate(statusMatch[2].trim()),
    statusPrefix: statusMatch[1],
  };
}

function prefixStructuredText(
  text: string,
  statusPrefix: string | null,
): string {
  return statusPrefix ? `${statusPrefix}\n\n${text}` : text;
}

export function normalizeEjclawStructuredOutput(
  result: string | null,
): NormalizedRunnerOutput {
  if (typeof result !== 'string' || result.length === 0) {
    return { result };
  }

  const trimmed = stripLeadingStructuredOutputControls(result.trim());
  const { jsonCandidate, statusPrefix } =
    extractStructuredCandidateWithOptionalStatus(trimmed);
  try {
    const parsed = JSON.parse(jsonCandidate) as {
      ejclaw?: {
        visibility?: unknown;
        text?: unknown;
        verdict?: unknown;
        attachments?: unknown;
      };
    };
    const envelope = parsed?.ejclaw;
    if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
      if (envelope.visibility === 'silent') {
        if (envelope.verdict !== undefined && envelope.verdict !== 'silent') {
          return normalizePublicTextOutput(result);
        }
        return {
          result: null,
          output: {
            visibility: 'silent',
            verdict:
              envelope.verdict === 'silent' ? ('silent' as const) : undefined,
          },
        };
      }

      if (
        envelope.visibility === 'public' &&
        typeof envelope.text === 'string' &&
        envelope.text.length > 0
      ) {
        if (
          envelope.verdict !== undefined &&
          !isVisibleVerdict(envelope.verdict)
        ) {
          return normalizePublicTextOutput(result);
        }
        const attachments = normalizeAttachments(envelope.attachments);
        const text = prefixStructuredText(envelope.text, statusPrefix);
        return {
          result: text,
          output: {
            visibility: 'public',
            text,
            verdict: isVisibleVerdict(envelope.verdict)
              ? envelope.verdict
              : undefined,
            ...(attachments.length > 0 ? { attachments } : {}),
          },
        };
      }
    }
  } catch {
    // Fall through to plain visible text output.
  }

  return normalizePublicTextOutput(result);
}

export function normalizeAgentOutput(
  result: string | null,
): NormalizedRunnerOutput {
  const normalized = normalizeEjclawStructuredOutput(result);
  if (
    normalized.output?.visibility !== 'public' ||
    typeof normalized.output.text !== 'string'
  ) {
    return normalized;
  }

  const explicitAttachments = normalized.output.attachments ?? [];
  if (explicitAttachments.length > 0) {
    return {
      ...normalized,
      attachmentSource: 'legacy-ejclaw-json',
    };
  }

  const mediaExtracted = extractMediaAttachments(normalized.output.text);
  const markdownExtracted = extractMarkdownImageAttachments(
    mediaExtracted.cleanText,
  );
  const imageTagExtracted = extractImageTagPaths(markdownExtracted.cleanText);
  const imageTagAttachments = imageTagPathsToAttachments(
    imageTagExtracted.imagePaths,
  );
  const attachments = uniqueAttachments([
    ...mediaExtracted.attachments,
    ...markdownExtracted.attachments,
    ...imageTagAttachments,
  ]);

  if (attachments.length === 0) {
    return {
      ...normalized,
      attachmentSource: normalized.attachmentSource ?? 'none',
    };
  }

  const attachmentSource =
    [
      mediaExtracted.attachments.length > 0,
      markdownExtracted.attachments.length > 0,
      imageTagAttachments.length > 0,
    ].filter(Boolean).length > 1
      ? 'mixed'
      : mediaExtracted.attachments.length > 0
        ? 'media-tag'
        : markdownExtracted.attachments.length > 0
          ? 'markdown-image'
          : 'image-tag';

  return {
    result: imageTagExtracted.cleanText,
    output: {
      visibility: 'public',
      text: imageTagExtracted.cleanText,
      ...(normalized.output.verdict
        ? { verdict: normalized.output.verdict }
        : {}),
      attachments,
    },
    attachmentSource,
  };
}
