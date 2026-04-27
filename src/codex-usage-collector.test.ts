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
  });

  afterEach(() => {
    delete process.env.CODEX_USAGE_TEST_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('refreshes usage via ~/.codex/auth.json when ~/.codex-accounts is missing', async () => {
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

    rotation.initCodexTokenRotation();
    const result = await usage.refreshActiveCodexUsage();

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
