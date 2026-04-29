import { getAgentOutputText } from './agent-output.js';
import type { AgentOutput } from './agent-runner.js';
import { isCodexBadRequestText } from './codex-bad-request-signal.js';

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

const CODEX_SESSION_RESET_PATTERNS = [
  /Error running remote compact task/i,
  /prompt_cache_retention/i,
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
  output: Pick<AgentOutput, 'result' | 'output' | 'error'>,
): boolean {
  const texts = [
    ...toText(getAgentOutputText(output)),
    ...toText(output.error),
  ];
  return texts.some((text) =>
    SESSION_RESET_PATTERNS.some((pattern) => pattern.test(text)),
  );
}

export function shouldRetryFreshSessionOnAgentFailure(
  output: Pick<AgentOutput, 'result' | 'output' | 'error'>,
): boolean {
  const texts = [
    ...toText(getAgentOutputText(output)),
    ...toText(output.error),
  ];
  return texts.some((text) =>
    SESSION_RETRY_PATTERNS.some((pattern) => pattern.test(text)),
  );
}

export function shouldResetCodexSessionOnAgentFailure(
  output: Pick<AgentOutput, 'result' | 'output' | 'error'>,
): boolean {
  const texts = [
    ...toText(getAgentOutputText(output)),
    ...toText(output.error),
  ];
  return texts.some((text) =>
    CODEX_SESSION_RESET_PATTERNS.some((pattern) => pattern.test(text)),
  );
}

export function shouldRetryFreshCodexSessionOnAgentFailure(
  output: Pick<AgentOutput, 'result' | 'output' | 'error'>,
): boolean {
  return shouldResetCodexSessionOnAgentFailure(output);
}

export function isCodexBadRequestSignal(
  output: Pick<AgentOutput, 'result' | 'output' | 'error'>,
): boolean {
  const texts = [
    ...toText(getAgentOutputText(output)),
    ...toText(output.error),
  ];
  return texts.some((text) => isCodexBadRequestText(text));
}
