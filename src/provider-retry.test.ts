import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./codex-token-rotation.js', () => ({
  detectCodexRotationTrigger: vi.fn(() => ({
    shouldRotate: false,
    reason: '',
  })),
  getCodexAccountCount: vi.fn(() => 1),
  markCodexTokenHealthy: vi.fn(),
  rotateCodexToken: vi.fn(() => false),
}));

vi.mock('./token-rotation.js', () => ({
  rotateToken: vi.fn(() => false),
  getTokenCount: vi.fn(() => 1),
  getCurrentTokenIndex: vi.fn(() => 0),
  markTokenHealthy: vi.fn(),
}));

vi.mock('./token-refresh.js', () => ({
  forceRefreshToken: vi.fn(async () => null),
}));

import { runClaudeRotationLoop } from './provider-retry.js';
import { runCodexRotationLoop } from './provider-retry.js';
import {
  detectCodexRotationTrigger,
  getCodexAccountCount,
  markCodexTokenHealthy,
  rotateCodexToken,
} from './codex-token-rotation.js';
import {
  getCurrentTokenIndex,
  getTokenCount,
  markTokenHealthy,
  rotateToken,
} from './token-rotation.js';
import { forceRefreshToken } from './token-refresh.js';

describe('runClaudeRotationLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTokenCount).mockReturnValue(1);
    vi.mocked(getCurrentTokenIndex).mockReturnValue(0);
    vi.mocked(rotateToken).mockReturnValue(false);
    vi.mocked(forceRefreshToken).mockResolvedValue(null);
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

    expect(outcome).toEqual({ type: 'success', sawOutput: true });
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

  it('force-refreshes the active token before rotating on auth-expired', async () => {
    vi.mocked(forceRefreshToken).mockResolvedValueOnce('new-access-token');

    const outcome = await runClaudeRotationLoop(
      { reason: 'auth-expired' },
      async () => ({
        output: { status: 'success', result: 'ok' },
        sawOutput: true,
      }),
      { runId: 'force-refresh-auth-expired' },
    );

    expect(outcome).toEqual({ type: 'success', sawOutput: true });
    expect(forceRefreshToken).toHaveBeenCalledWith(0);
    expect(rotateToken).not.toHaveBeenCalled();
    expect(markTokenHealthy).toHaveBeenCalledTimes(1);
  });

  it('falls back to rotation when force refresh does not recover auth-expired', async () => {
    vi.mocked(getTokenCount).mockReturnValue(2);
    vi.mocked(forceRefreshToken).mockResolvedValueOnce('new-access-token');
    vi.mocked(rotateToken).mockReturnValueOnce(true);

    let attempts = 0;
    const outcome = await runClaudeRotationLoop(
      { reason: 'auth-expired' },
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            output: {
              status: 'error',
              result: null,
              error:
                'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
            },
            sawOutput: false,
          };
        }

        return {
          output: { status: 'success', result: 'ok' },
          sawOutput: true,
        };
      },
      { runId: 'force-refresh-then-rotate' },
    );

    expect(outcome).toEqual({ type: 'success', sawOutput: true });
    expect(forceRefreshToken).toHaveBeenCalledWith(0);
    expect(rotateToken).toHaveBeenCalledTimes(1);
    expect(markTokenHealthy).toHaveBeenCalledTimes(1);
  });

  it('uses structured public output text as the next rotation message', async () => {
    vi.mocked(getTokenCount).mockReturnValue(2);
    vi.mocked(rotateToken).mockReturnValueOnce(true).mockReturnValueOnce(false);

    let attempts = 0;
    const outcome = await runClaudeRotationLoop(
      { reason: '429' },
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            output: {
              status: 'success',
              result: null,
              output: { visibility: 'public', text: 'retry with next token' },
            },
            sawOutput: false,
            streamedTriggerReason: { reason: 'usage-exhausted' },
          };
        }

        return {
          output: { status: 'success', result: 'ok' },
          sawOutput: true,
        };
      },
      { runId: 'structured-rotation-message' },
    );

    expect(outcome).toEqual({
      type: 'error',
      trigger: { reason: 'usage-exhausted' },
    });
    expect(rotateToken).toHaveBeenNthCalledWith(2, 'retry with next token');
  });
});

describe('runCodexRotationLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCodexAccountCount).mockReturnValue(1);
    vi.mocked(rotateCodexToken).mockReturnValue(false);
  });

  it('rotates and succeeds after a Codex auth trigger', async () => {
    vi.mocked(getCodexAccountCount).mockReturnValue(2);
    vi.mocked(rotateCodexToken).mockReturnValueOnce(true);

    const outcome = await runCodexRotationLoop(
      { reason: 'auth-expired' },
      async () => ({
        output: { status: 'success', result: 'ok' },
        sawOutput: true,
      }),
      { runId: 'rotate-codex-auth' },
    );

    expect(outcome).toEqual({ type: 'success' });
    expect(rotateCodexToken).toHaveBeenCalledTimes(1);
    expect(markCodexTokenHealthy).toHaveBeenCalledTimes(1);
  });

  it('continues rotation when streamed trigger arrives before visible output', async () => {
    vi.mocked(getCodexAccountCount).mockReturnValue(2);
    vi.mocked(rotateCodexToken)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    let attempts = 0;
    const outcome = await runCodexRotationLoop(
      { reason: 'auth-expired' },
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            output: { status: 'success', result: 'rotate next' },
            sawOutput: false,
            streamedTriggerReason: { reason: 'auth-expired' },
          };
        }

        return {
          output: { status: 'success', result: 'ok' },
          sawOutput: true,
        };
      },
      { runId: 'rotate-codex-streamed' },
    );

    expect(outcome).toEqual({ type: 'error' });
    expect(rotateCodexToken).toHaveBeenNthCalledWith(2, 'rotate next');
  });

  it('uses the Codex detector for thrown errors', async () => {
    vi.mocked(getCodexAccountCount).mockReturnValue(2);
    vi.mocked(rotateCodexToken).mockReturnValueOnce(true);
    vi.mocked(detectCodexRotationTrigger).mockReturnValue({
      shouldRotate: true,
      reason: 'auth-expired',
    });

    const outcome = await runCodexRotationLoop(
      { reason: 'auth-expired' },
      async () => ({
        thrownError: new Error('OAuth token expired'),
        sawOutput: false,
      }),
      { runId: 'rotate-codex-error' },
    );

    expect(outcome).toEqual({ type: 'error' });
    expect(detectCodexRotationTrigger).toHaveBeenCalledWith(
      'OAuth token expired',
    );
  });
});
