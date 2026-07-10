import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/ejclaw-codex-usage-data',
}));

vi.mock('./utils.js', async () => {
  const actual =
    await vi.importActual<typeof import('./utils.js')>('./utils.js');
  return {
    ...actual,
    writeJsonFile: vi.fn(),
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => process.env.CODEX_USAGE_TEST_HOME || '/tmp',
    },
    homedir: () => process.env.CODEX_USAGE_TEST_HOME || '/tmp',
  };
});

function createDefaultCodexAuth(homeDir: string): string {
  const authPath = path.join(homeDir, '.codex', 'auth.json');
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { account_id: 'default-acct', access_token: 'default-token' },
    }),
  );
  return authPath;
}

function createCodexAccounts(homeDir: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const authPath = path.join(
      homeDir,
      '.codex-accounts',
      String(index),
      'auth.json',
    );
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          account_id: `account-${index}`,
          access_token: `test-access-${index}`,
        },
      }),
    );
  }
}

function createWhamResponse(args?: {
  planType?: string;
  limitReached?: boolean;
  h5pct?: number;
  d7pct?: number;
}): Response {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Response.json({
    plan_type: args?.planType ?? 'pro',
    rate_limit: {
      allowed: true,
      limit_reached: args?.limitReached ?? false,
      primary_window: {
        used_percent: args?.h5pct ?? 12.4,
        reset_at: nowSeconds + 3_600,
      },
      secondary_window: {
        used_percent: args?.d7pct ?? 67.6,
        reset_at: nowSeconds + 86_400,
      },
    },
  });
}

function createFakeChildProcess(rateLimitsByLimitId: Record<string, unknown>) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  const stdout = new EventEmitter();
  proc.stdout = stdout;
  proc.stdin = {
    write: vi.fn((payload: string) => {
      const message = JSON.parse(payload.trim()) as {
        id: number;
        method?: string;
      };
      if (message.id === 1) {
        setImmediate(() => {
          stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ id: 1, result: {} })}\n`),
          );
        });
      }
      if (message.id === 2 && message.method === 'account/rateLimits/read') {
        setImmediate(() => {
          stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                id: 2,
                result: { rateLimitsByLimitId },
              })}\n`,
            ),
          );
        });
      }
      return true;
    }),
  };
  proc.kill = vi.fn();
  return proc;
}

describe('codex-usage-collector fallback account usage', () => {
  let tempHome: string;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tempHome = fs.mkdtempSync(path.join('/tmp', 'ejclaw-codex-usage-'));
    process.env.CODEX_USAGE_TEST_HOME = tempHome;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CODEX_USAGE_TEST_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('uses direct wham usage for every account and preserves an unknown plan type', async () => {
    createCodexAccounts(tempHome, 2);
    const childProcess = await import('child_process');
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValueOnce(
        createWhamResponse({
          planType: 'prolite',
          h5pct: 2.4,
          d7pct: 41.6,
        }),
      )
      .mockResolvedValueOnce(
        createWhamResponse({
          planType: 'prolite',
          h5pct: 87.2,
          d7pct: 53.1,
        }),
      );

    const rotation = await import('./codex-token-rotation.js');
    const usage = await import('./codex-usage-collector.js');
    const utils = await import('./utils.js');

    rotation.initCodexTokenRotation();
    const result = await usage.refreshAllCodexAccountUsage();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(result.fetchedAt).toEqual(expect.any(String));
    expect(result.rows).toEqual([
      expect.objectContaining({
        name: 'Codex1* prolite',
        h5pct: 2,
        d7pct: 42,
        fetchedAt: expect.any(String),
      }),
      expect.objectContaining({
        name: 'Codex2  prolite',
        h5pct: 87,
        d7pct: 53,
        fetchedAt: expect.any(String),
      }),
    ]);
    expect(vi.mocked(utils.writeJsonFile)).toHaveBeenLastCalledWith(
      '/tmp/ejclaw-codex-usage-data/codex-rotation-state.json',
      expect.objectContaining({
        usageFetchedAts: [expect.any(String), expect.any(String)],
        usageLimitReached: [false, false],
        planTypes: ['prolite', 'prolite'],
      }),
    );
  });

  it('preserves limit_reached independently of the reported percentage', async () => {
    createDefaultCodexAuth(tempHome);
    vi.mocked(fetch).mockResolvedValueOnce(
      createWhamResponse({
        limitReached: true,
        h5pct: 87.2,
      }),
    );

    const rotation = await import('./codex-token-rotation.js');
    const usage = await import('./codex-usage-collector.js');

    rotation.initCodexTokenRotation();
    const result = await usage.refreshActiveCodexUsage();

    expect(result.rows).toEqual([
      expect.objectContaining({
        name: 'Codex',
        h5pct: 87,
        limitReached: true,
      }),
    ]);
  });

  it('falls back to app-server on wham 401', async () => {
    createDefaultCodexAuth(tempHome);
    const childProcess = await import('child_process');
    const fallbackCodexHome = path.join(tempHome, '.codex');
    let capturedCodexHome: string | undefined;

    vi.mocked(childProcess.spawn).mockImplementation(((
      _cmd: string,
      _args: readonly string[] | undefined,
      opts?: { env?: Record<string, string> },
    ) => {
      capturedCodexHome = opts?.env?.CODEX_HOME;
      return createFakeChildProcess({
        codex: {
          limitName: 'Codex',
          primary: {
            usedPercent: 12.4,
            resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
          secondary: {
            usedPercent: 67.6,
            resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
      }) as never;
    }) as unknown as typeof childProcess.spawn);

    const rotation = await import('./codex-token-rotation.js');
    const usage = await import('./codex-usage-collector.js');
    const { logger } = await import('./logger.js');

    rotation.initCodexTokenRotation();
    const result = await usage.refreshActiveCodexUsage();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rotation.getCodexAccountCount()).toBe(1);
    expect(capturedCodexHome).toBe(fallbackCodexHome);
    expect(result.fetchedAt).toEqual(expect.any(String));
    expect(result.rows).toEqual([
      expect.objectContaining({
        name: 'Codex',
        h5pct: 12,
        d7pct: 68,
      }),
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      { account: 1 },
      'Direct Codex usage fetch failed; falling back to app-server',
    );
  });

  it('finds codex via ~/.hermes/node/bin when running under bun', async () => {
    createDefaultCodexAuth(tempHome);
    const childProcess = await import('child_process');
    const bunExecPath = path.join(tempHome, '.bun', 'bin', 'bun');
    const hermesBin = path.join(tempHome, '.hermes', 'node', 'bin');
    const originalExecPath = process.execPath;
    const originalPath = process.env.PATH;

    fs.mkdirSync(hermesBin, { recursive: true });
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      writable: true,
      value: bunExecPath,
    });

    vi.mocked(childProcess.spawn).mockImplementation(((
      cmd: string,
      _args: readonly string[] | undefined,
      opts?: { env?: Record<string, string> },
    ) => {
      const spawnPathEntries = (opts?.env?.PATH || '').split(path.delimiter);
      expect(cmd).toBe('codex');
      expect(spawnPathEntries).toContain(path.dirname(bunExecPath));
      expect(spawnPathEntries).toContain(hermesBin);

      if (!spawnPathEntries.includes(hermesBin)) {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stdin: { write: ReturnType<typeof vi.fn> };
          kill: ReturnType<typeof vi.fn>;
        };
        proc.stdout = new EventEmitter();
        proc.stdin = { write: vi.fn() };
        proc.kill = vi.fn();
        setImmediate(() => proc.emit('error', new Error('spawn codex ENOENT')));
        return proc as never;
      }

      return createFakeChildProcess({
        codex: {
          limitName: 'Codex',
          primary: {
            usedPercent: 34.2,
            resetsAt: new Date(Date.now() + 7_200_000).toISOString(),
          },
          secondary: {
            usedPercent: 56.1,
            resetsAt: new Date(Date.now() + 172_800_000).toISOString(),
          },
        },
      }) as never;
    }) as unknown as typeof childProcess.spawn);

    try {
      const rotation = await import('./codex-token-rotation.js');
      const usage = await import('./codex-usage-collector.js');

      rotation.initCodexTokenRotation();
      const result = await usage.refreshActiveCodexUsage();

      expect(result.fetchedAt).toEqual(expect.any(String));
      expect(result.rows).toEqual([
        expect.objectContaining({
          name: 'Codex',
          h5pct: 34,
          d7pct: 56,
        }),
      ]);
    } finally {
      Object.defineProperty(process, 'execPath', {
        configurable: true,
        writable: true,
        value: originalExecPath,
      });
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });
});
