import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./token-rotation.js', () => ({
  rotateToken: vi.fn(() => false),
  getTokenCount: vi.fn(() => 1),
  markTokenHealthy: vi.fn(),
}));

import { runClaudeRotationLoop } from './provider-retry.js';
import {
  getTokenCount,
  markTokenHealthy,
  rotateToken,
} from './token-rotation.js';

describe('runClaudeRotationLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTokenCount).mockReturnValue(1);
    vi.mocked(rotateToken).mockReturnValue(false);
  });

  it('rotates and succeeds after an org-access-denied trigger', async () => {
    vi.mocked(getTokenCount).mockReturnValue(2);
    vi.mocked(rotateToken).mockReturnValueOnce(true);

    const outcome = await runClaudeRotationLoop(
      { reason: 'org-access-denied' },
      async () => ({
        output: { status: 'success', result: 'ok' },
        sawOutput: true,
      }),
      { runId: 'rotate-org-access' },
    );

    expect(outcome).toEqual({ type: 'success' });
    expect(rotateToken).toHaveBeenCalledTimes(1);
    expect(markTokenHealthy).toHaveBeenCalledTimes(1);
  });

  it('returns error when all Claude tokens are exhausted', async () => {
    vi.mocked(getTokenCount).mockReturnValue(2);

    const outcome = await runClaudeRotationLoop(
      { reason: 'org-access-denied' },
      async () => ({
        output: { status: 'success', result: 'should not run' },
        sawOutput: true,
      }),
      { runId: 'no-fallback-org-access' },
    );

    expect(outcome).toEqual({
      type: 'error',
      trigger: { reason: 'org-access-denied' },
    });
  });

  it('returns error with success-null-result trigger after rotation', async () => {
    vi.mocked(getTokenCount).mockReturnValue(2);
    vi.mocked(rotateToken).mockReturnValueOnce(true);

    const outcome = await runClaudeRotationLoop(
      { reason: '429' },
      async () => ({
        output: { status: 'success', result: null },
        sawOutput: false,
        sawSuccessNullResult: true,
      }),
      { runId: 'success-null-result' },
    );

    expect(outcome).toEqual({
      type: 'error',
      trigger: { reason: 'success-null-result' },
    });
  });
});
