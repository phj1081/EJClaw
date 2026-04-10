export const OUTPUT_START_MARKER = '---EJCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---EJCLAW_OUTPUT_END---';

export const IMAGE_TAG_RE = /\[Image:\s*(\/[^\]]+)\]/g;

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
  | 'silent';

export type RunnerOutputVisibility = 'public' | 'silent';

export type RunnerStructuredOutput =
  | {
      visibility: 'public';
      text: string;
      verdict?: Exclude<RunnerOutputVerdict, 'silent'>;
    }
  | {
      visibility: 'silent';
      verdict?: 'silent';
    };

export interface NormalizedRunnerOutput {
  result: string | null;
  output?: RunnerStructuredOutput;
}

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
    value === 'done' || value === 'done_with_concerns' || value === 'blocked'
  );
}

export function normalizeEjclawStructuredOutput(
  result: string | null,
): NormalizedRunnerOutput {
  if (typeof result !== 'string' || result.length === 0) {
    return { result };
  }

  const trimmed = result.trim();
  try {
    const parsed = JSON.parse(trimmed) as {
      ejclaw?: { visibility?: unknown; text?: unknown; verdict?: unknown };
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
        return {
          result: envelope.text,
          output: {
            visibility: 'public',
            text: envelope.text,
            verdict: isVisibleVerdict(envelope.verdict)
              ? envelope.verdict
              : undefined,
          },
        };
      }
    }
  } catch {
    // Fall through to plain visible text output.
  }

  return normalizePublicTextOutput(result);
}
