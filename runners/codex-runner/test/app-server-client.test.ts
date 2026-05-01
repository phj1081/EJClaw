import { describe, expect, it, vi } from 'vitest';

import {
  CodexAppServerClient,
  buildCodexAppServerArgs,
} from '../src/app-server-client.js';

describe('codex app-server client goals', () => {
  it('does not enable goals by default when spawning app-server', () => {
    expect(
      buildCodexAppServerArgs({
        codexBin: '/opt/codex/bin/codex.js',
      }),
    ).toEqual(['/opt/codex/bin/codex.js', 'app-server']);
  });

  it('adds the under-development goals feature only when explicitly enabled', () => {
    expect(
      buildCodexAppServerArgs({
        codexBin: '/opt/codex/bin/codex.js',
        enableGoals: true,
      }),
    ).toEqual(['/opt/codex/bin/codex.js', '--enable', 'goals', 'app-server']);
  });

  it('wraps thread goal JSON-RPC methods with the upstream objective field', async () => {
    const client = new CodexAppServerClient({
      cwd: '/repo',
      log: () => undefined,
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        goal: {
          threadId: 'thread-1',
          objective: 'ship the release',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      .mockResolvedValueOnce({
        goal: {
          threadId: 'thread-1',
          objective: 'ship the release',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      .mockResolvedValueOnce({ cleared: true });
    (
      client as unknown as {
        request: (method: string, params?: unknown) => Promise<unknown>;
      }
    ).request = request;

    await expect(
      client.threadGoalSet('thread-1', 'ship the release'),
    ).resolves.toMatchObject({
      threadId: 'thread-1',
      objective: 'ship the release',
      status: 'active',
    });
    await expect(client.threadGoalGet('thread-1')).resolves.toMatchObject({
      objective: 'ship the release',
    });
    await expect(client.threadGoalClear('thread-1')).resolves.toBe(true);

    expect(request).toHaveBeenNthCalledWith(1, 'thread/goal/set', {
      threadId: 'thread-1',
      objective: 'ship the release',
    });
    expect(request).toHaveBeenNthCalledWith(2, 'thread/goal/get', {
      threadId: 'thread-1',
    });
    expect(request).toHaveBeenNthCalledWith(3, 'thread/goal/clear', {
      threadId: 'thread-1',
    });
  });
});
