import type { StructuredAgentOutput } from './types.js';

export function stringifyLegacyAgentResult(
  result: string | object | null | undefined,
): string | null {
  if (result === null || result === undefined) return null;
  if (typeof result === 'string') return result;

  try {
    return JSON.stringify(result);
  } catch {
    return null;
  }
}

export function getAgentOutputText(output: {
  output?: StructuredAgentOutput;
  result?: string | object | null;
}): string | null {
  if (output.output?.visibility === 'silent') {
    return null;
  }
  if (output.output?.visibility === 'public') {
    return output.output.text;
  }
  return stringifyLegacyAgentResult(output.result);
}

export function isSilentAgentOutput(output: {
  output?: StructuredAgentOutput;
}): boolean {
  return output.output?.visibility === 'silent';
}
