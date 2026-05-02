export const OUTPUT_START_MARKER = '---EJCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---EJCLAW_OUTPUT_END---';

export const IMAGE_TAG_RE =
  /\[Image:\s*(?:(?:[^\]\n]*?)\s*→\s*)?(\/[^\]\n]+)\]/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MARKDOWN_ABSOLUTE_LINK_RE = /!?\[[^\]\n]*\]\((\/[^)\n]+)\)/g;

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
    | 'markdown-image'
    | 'image-tag'
    | 'mixed'
    | 'none';
}

export type NormalizedAgentOutput = NormalizedRunnerOutput;

function cloneImageTagPattern(): RegExp {
  return new RegExp(IMAGE_TAG_RE.source, IMAGE_TAG_RE.flags);
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
    MARKDOWN_ABSOLUTE_LINK_RE,
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

  const markdownExtracted = extractMarkdownImageAttachments(
    normalized.output.text,
  );
  const imageTagExtracted = extractImageTagPaths(markdownExtracted.cleanText);
  const imageTagAttachments = imageTagPathsToAttachments(
    imageTagExtracted.imagePaths,
  );
  const attachments = uniqueAttachments([
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
    markdownExtracted.attachments.length > 0 && imageTagAttachments.length > 0
      ? 'mixed'
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
