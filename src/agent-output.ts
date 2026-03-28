import { parseStructuredOutputEnvelope } from './output-suppression.js';
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

export function getStructuredAgentOutput(output: {
  output?: StructuredAgentOutput;
  result?: string | object | null;
}): StructuredAgentOutput | null {
  if (output.output) {
    return output.output;
  }
  if (typeof output.result !== 'string') {
    return null;
  }
  return parseStructuredOutputEnvelope(output.result.trim());
}

export function getAgentOutputText(output: {
  output?: StructuredAgentOutput;
  result?: string | object | null;
}): string | null {
  const structured = getStructuredAgentOutput(output);
  if (structured?.visibility === 'silent') {
    return null;
  }
  if (structured?.visibility === 'public') {
    return structured.text;
  }
  return stringifyLegacyAgentResult(output.result);
}

export function hasAgentOutputPayload(output: {
  output?: StructuredAgentOutput;
  result?: string | object | null;
}): boolean {
  if (output.output) {
    return true;
  }
  return output.result !== null && output.result !== undefined;
}

export function isSilentAgentOutput(output: {
  output?: StructuredAgentOutput;
  result?: string | object | null;
}): boolean {
  return getStructuredAgentOutput(output)?.visibility === 'silent';
}
