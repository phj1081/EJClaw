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
  /Codex ran out of room in the model's context window/i,
  /Start a new thread or clear earlier history before retrying/i,
  /prompt_cache_retention/i,
];

/**
 * Raw provider error passthroughs (e.g. "No conversation found with session
 * ID: <uuid>") arrive as short standalone texts. Longer visible outputs that
 * merely QUOTE such an error (e.g. an agent debugging EJClaw itself) must not
 * be mistaken for a session failure, so pattern matching on visible text is
 * limited to short texts. The dedicated error field is always matched in full.
 */
const RAW_PROVIDER_ERROR_MAX_LENGTH = 600;

function toText(value: string | object | null | undefined): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];

  try {
    return [JSON.stringify(value)];
  } catch {
    return [];
  }
}

function hasSessionSignal(
  output: Pick<AgentOutput, 'result' | 'output' | 'error'>,
  patterns: RegExp[],
): boolean {
  const errorMatched = toText(output.error).some((text) =>
    patterns.some((pattern) => pattern.test(text)),
  );
  if (errorMatched) return true;

  return toText(getAgentOutputText(output)).some(
    (text) =>
      text.trim().length <= RAW_PROVIDER_ERROR_MAX_LENGTH &&
      patterns.some((pattern) => pattern.test(text)),
  );
}

export function shouldResetSessionOnAgentFailure(
  output: Pick<AgentOutput, 'result' | 'output' | 'error'>,
): boolean {
  return hasSessionSignal(output, SESSION_RESET_PATTERNS);
}

export function shouldRetryFreshSessionOnAgentFailure(
  output: Pick<AgentOutput, 'result' | 'output' | 'error'>,
): boolean {
  return hasSessionSignal(output, SESSION_RETRY_PATTERNS);
}

export function shouldResetCodexSessionOnAgentFailure(
  output: Pick<AgentOutput, 'result' | 'output' | 'error'>,
): boolean {
  return hasSessionSignal(output, CODEX_SESSION_RESET_PATTERNS);
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
