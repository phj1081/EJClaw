import { describe, expect, it } from 'vitest';

import { resolveAttemptRetryAction } from './agent-attempt-retry.js';

describe('resolveAttemptRetryAction', () => {
  it('uses the streamed Codex trigger message as the rotation message', () => {
    const errorMessage =
      'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header';

    const action = resolveAttemptRetryAction({
      provider: 'codex',
      canRetryClaudeCredentials: false,
      canRetryCodex: true,
      attempt: {
        sawOutput: false,
        streamedTriggerReason: {
          reason: 'auth-expired',
          message: errorMessage,
        } as any,
      },
    });

    expect(action).toEqual({
      kind: 'codex',
      trigger: { reason: 'auth-expired' },
      rotationMessage: errorMessage,
    });
  });
});
