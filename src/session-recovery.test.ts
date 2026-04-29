import { describe, expect, it } from 'vitest';

import {
  isCodexBadRequestSignal,
  shouldResetCodexSessionOnAgentFailure,
  shouldResetSessionOnAgentFailure,
  shouldRetryFreshCodexSessionOnAgentFailure,
  shouldRetryFreshSessionOnAgentFailure,
} from './session-recovery.js';

describe('shouldResetSessionOnAgentFailure', () => {
  it('matches many-image dimension limit errors', () => {
    expect(
      shouldResetSessionOnAgentFailure({
        result:
          'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
        error: undefined,
      }),
    ).toBe(true);
  });

  it('matches the error field too', () => {
    expect(
      shouldResetSessionOnAgentFailure({
        result: null,
        error:
          'fatal: An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
      }),
    ).toBe(true);
  });

  it('does not match unrelated agent failures', () => {
    expect(
      shouldResetSessionOnAgentFailure({
        result: null,
        error: 'Claude Code process exited with code 1',
      }),
    ).toBe(false);
  });

  it('matches thinking signature 400 errors', () => {
    expect(
      shouldResetSessionOnAgentFailure({
        result:
          'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.11.content.0: Invalid `signature` in `thinking` block"}}',
        error: undefined,
      }),
    ).toBe(true);
  });

  it('matches structured public output text too', () => {
    expect(
      shouldResetSessionOnAgentFailure({
        result: null,
        output: {
          visibility: 'public',
          text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.11.content.0: Invalid `signature` in `thinking` block"}}',
        },
        error: undefined,
      }),
    ).toBe(true);
  });
});

describe('shouldRetryFreshSessionOnAgentFailure', () => {
  it('matches stale session errors', () => {
    expect(
      shouldRetryFreshSessionOnAgentFailure({
        result: null,
        error: 'No conversation found with session ID: stale',
      }),
    ).toBe(true);
  });

  it('matches thinking signature 400 errors', () => {
    expect(
      shouldRetryFreshSessionOnAgentFailure({
        result:
          'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.11.content.0: Invalid `signature` in `thinking` block"}}',
        error: undefined,
      }),
    ).toBe(true);
  });

  it('does not retry image dimension limit errors', () => {
    expect(
      shouldRetryFreshSessionOnAgentFailure({
        result:
          'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
        error: undefined,
      }),
    ).toBe(false);
  });

  it('does not treat structured silent output as a retryable session failure', () => {
    expect(
      shouldRetryFreshSessionOnAgentFailure({
        result: null,
        output: { visibility: 'silent' },
        error: undefined,
      }),
    ).toBe(false);
  });
});

describe('shouldResetCodexSessionOnAgentFailure', () => {
  it('matches remote compact task failures that mention prompt_cache_retention', () => {
    expect(
      shouldResetCodexSessionOnAgentFailure({
        result: null,
        error:
          "Error running remote compact task: Unknown parameter: 'prompt_cache_retention'",
      }),
    ).toBe(true);
  });

  it('does not match unrelated Codex failures', () => {
    expect(
      shouldResetCodexSessionOnAgentFailure({
        result: null,
        error: 'Codex process exited with code 1',
      }),
    ).toBe(false);
  });
});

describe('shouldRetryFreshCodexSessionOnAgentFailure', () => {
  it('retries the same remote compact task failure with a fresh session', () => {
    expect(
      shouldRetryFreshCodexSessionOnAgentFailure({
        result: null,
        error:
          "Error running remote compact task: Unknown parameter: 'prompt_cache_retention'",
      }),
    ).toBe(true);
  });

  it('does not retry generic Codex Bad Request signals during observation-only rollout', () => {
    const output = {
      result: null,
      error: '{"detail":"Bad Request"}',
    };

    expect(isCodexBadRequestSignal(output)).toBe(true);
    expect(shouldResetCodexSessionOnAgentFailure(output)).toBe(false);
    expect(shouldRetryFreshCodexSessionOnAgentFailure(output)).toBe(false);
  });

  it('does not flag unrelated Bad Request text as the narrow Codex signal', () => {
    expect(
      isCodexBadRequestSignal({
        result: null,
        error: 'HTTP 400 Bad Request',
      }),
    ).toBe(false);
  });
});
