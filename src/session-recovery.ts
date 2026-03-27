import type { AgentOutput } from './agent-runner.js';

const SESSION_RESET_PATTERNS = [
  /An image in the conversation exceeds the dimension limit for many-image requests \(2000px\)\./i,
  /Start a new session with fewer images\./i,
  /No conversation found with session ID/i,
  /400[^\n]*thinking/i,
  /thinking[^\n]*block[^\n]*(?:invalid|error|signature)/i,
  /invalid[^\n]*signature[^\n]*thinking/i,
];

const SESSION_RETRY_PATTERNS = [
  /No conversation found with session ID/i,
  /400[^\n]*thinking/i,
  /thinking[^\n]*block[^\n]*(?:invalid|error|signature)/i,
  /invalid[^\n]*signature[^\n]*thinking/i,
];

function toText(value: string | object | null | undefined): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];

  try {
    return [JSON.stringify(value)];
  } catch {
    return [];
  }
}

export function shouldResetSessionOnAgentFailure(
  output: Pick<AgentOutput, 'result' | 'error'>,
): boolean {
  const texts = [...toText(output.result), ...toText(output.error)];
  return texts.some((text) =>
    SESSION_RESET_PATTERNS.some((pattern) => pattern.test(text)),
  );
}

export function shouldRetryFreshSessionOnAgentFailure(
  output: Pick<AgentOutput, 'result' | 'error'>,
): boolean {
  const texts = [...toText(output.result), ...toText(output.error)];
  return texts.some((text) =>
    SESSION_RETRY_PATTERNS.some((pattern) => pattern.test(text)),
  );
}
