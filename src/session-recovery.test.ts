import { describe, expect, it } from 'vitest';

import {
  shouldResetSessionOnAgentFailure,
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
});
