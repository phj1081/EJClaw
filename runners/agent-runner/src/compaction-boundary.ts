import {
  compactBoundaryOutput,
  type RunnerCompaction,
} from './output-protocol.js';

export function compactBoundaryFromMessage(
  message: unknown,
  log: (message: string) => void,
): RunnerCompaction | undefined {
  if (
    !(
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: string }).type === 'system' &&
      (message as { subtype?: string }).subtype === 'compact_boundary'
    )
  ) {
    return undefined;
  }
  const meta = (
    message as {
      compact_metadata?: { trigger?: string; pre_tokens?: number };
    }
  ).compact_metadata;
  log(
    `Compact boundary — trigger=${meta?.trigger || '?'} pre_tokens=${meta?.pre_tokens ?? '?'}`,
  );
  return compactBoundaryOutput(meta?.trigger);
}
