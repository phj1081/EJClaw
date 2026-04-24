import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('./codex-token-rotation.js', () => ({
  getAllCodexAccounts: vi.fn(),
  getCodexAuthPath: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

type FakeProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
};

function createFakeCodexProcess(exitCode = 0): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  setImmediate(() => {
    proc.stdout.emit('data', Buffer.from('OK\n'));
    proc.emit('close', exitCode, null);
  });
  return proc;
}

function authPathFor(tempHome: string, accountIndex: number): string {
  return path.join(
    tempHome,
    '.codex-accounts',
    String(accountIndex + 1),
    'auth.json',
  );
}

describe('Codex warm-up scheduler', () => {
  let tempHome: string;
  let statePath: string;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tempHome = fs.mkdtempSync(path.join('/tmp', 'ejclaw-codex-warmup-'));
    statePath = path.join(tempHome, 'codex-warmup-state.json');
    for (let i = 0; i < 3; i++) {
      const p = authPathFor(tempHome, i);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '{}');
    }
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('warms one eligible zero-usage account with a real codex exec and persists account cooldown state', async () => {
    const childProcess = await import('child_process');
    const rotation = await import('./codex-token-rotation.js');
    const { runCodexWarmupCycle } = await import('./codex-warmup.js');
    const now = new Date('2026-04-24T09:00:00Z').getTime();
    let capturedEnv: Record<string, string> | undefined;
    let capturedArgs: readonly string[] | undefined;

    vi.mocked(rotation.getAllCodexAccounts).mockReturnValue([
      {
        index: 0,
        accountId: 'busy-account',
        planType: 'pro',
        isActive: true,
        isRateLimited: false,
        cachedUsagePct: 14,
        cachedUsageD7Pct: 30,
      },
      {
        index: 1,
        accountId: 'rate-limited-account',
        planType: 'pro',
        isActive: false,
        isRateLimited: true,
        cachedUsagePct: 0,
        cachedUsageD7Pct: 0,
      },
      {
        index: 2,
        accountId: 'fresh-account',
        planType: 'team',
        isActive: false,
        isRateLimited: false,
        cachedUsagePct: 0,
        cachedUsageD7Pct: 0,
        resetAt: '2026-04-24T14:00:00.000Z',
        resetD7At: '2026-05-01T09:00:00.000Z',
      },
    ]);
    vi.mocked(rotation.getCodexAuthPath).mockImplementation(
      (accountIndex = 0) => authPathFor(tempHome, accountIndex),
    );
    vi.mocked(childProcess.spawn).mockImplementation(((
      _cmd: string,
      args?: readonly string[],
      opts?: { env?: Record<string, string> },
    ) => {
      capturedArgs = args;
      capturedEnv = opts?.env;
      return createFakeCodexProcess(0) as never;
    }) as unknown as typeof childProcess.spawn);

    const result = await runCodexWarmupCycle(
      {
        enabled: true,
        prompt: 'Reply exactly OK. Do not run tools.',
        model: 'gpt-5.5',
        intervalMs: 300_000,
        minIntervalMs: 18_300_000,
        staggerMs: 1_800_000,
        maxUsagePct: 0,
        maxD7UsagePct: 0,
        commandTimeoutMs: 120_000,
        failureCooldownMs: 21_600_000,
        maxConsecutiveFailures: 2,
      },
      { nowMs: now, statePath },
    );

    expect(result).toEqual({ status: 'warmed', accountIndex: 2 });
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(capturedArgs).toEqual(
      expect.arrayContaining([
        'exec',
        '--ephemeral',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '-m',
        'gpt-5.5',
        'Reply exactly OK. Do not run tools.',
      ]),
    );
    expect(capturedEnv?.CODEX_HOME).toBe(
      path.dirname(authPathFor(tempHome, 2)),
    );

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.lastWarmupAt).toBe('2026-04-24T09:00:00.000Z');
    expect(state.accounts['2'].lastWarmupAt).toBe('2026-04-24T09:00:00.000Z');
    expect(state.accounts['2'].zeroUsageWarmupUntil).toBe(
      '2026-05-01T09:00:00.000Z',
    );
    expect(state.consecutiveFailures).toBe(0);
  });

  it('does not repeat warm-up while the same zero-usage quota window is already marked warmed', async () => {
    const childProcess = await import('child_process');
    const rotation = await import('./codex-token-rotation.js');
    const { runCodexWarmupCycle } = await import('./codex-warmup.js');
    const now = new Date('2026-04-24T15:00:00Z').getTime();

    fs.writeFileSync(
      statePath,
      JSON.stringify({
        lastWarmupAt: '2026-04-24T09:00:00.000Z',
        consecutiveFailures: 0,
        accounts: {
          '0': {
            lastWarmupAt: '2026-04-24T09:00:00.000Z',
            zeroUsageWarmupUntil: '2026-05-01T09:00:00.000Z',
          },
        },
      }),
    );
    vi.mocked(rotation.getAllCodexAccounts).mockReturnValue([
      {
        index: 0,
        accountId: 'fresh-account-still-rounded-zero',
        planType: 'pro',
        isActive: false,
        isRateLimited: false,
        cachedUsagePct: 0,
        cachedUsageD7Pct: 0,
        resetAt: '2026-04-24T14:00:00.000Z',
        resetD7At: '2026-05-01T09:00:00.000Z',
      },
    ]);

    const result = await runCodexWarmupCycle(
      {
        enabled: true,
        prompt: 'Reply exactly OK. Do not run tools.',
        model: 'gpt-5.5',
        intervalMs: 300_000,
        minIntervalMs: 18_300_000,
        staggerMs: 0,
        maxUsagePct: 0,
        maxD7UsagePct: 0,
        commandTimeoutMs: 120_000,
        failureCooldownMs: 21_600_000,
        maxConsecutiveFailures: 2,
      },
      { nowMs: now, statePath },
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: 'no_eligible_accounts',
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('auto-backs off after repeated codex exec failures so OpenAI-side blocking does not hammer accounts', async () => {
    const childProcess = await import('child_process');
    const rotation = await import('./codex-token-rotation.js');
    const { runCodexWarmupCycle } = await import('./codex-warmup.js');
    const now = new Date('2026-04-24T09:00:00Z').getTime();

    vi.mocked(rotation.getAllCodexAccounts).mockReturnValue([
      {
        index: 0,
        accountId: 'fresh-account',
        planType: 'pro',
        isActive: false,
        isRateLimited: false,
        cachedUsagePct: 0,
        cachedUsageD7Pct: 0,
      },
    ]);
    vi.mocked(rotation.getCodexAuthPath).mockImplementation(
      (accountIndex = 0) => authPathFor(tempHome, accountIndex),
    );
    vi.mocked(childProcess.spawn).mockImplementation(
      () => createFakeCodexProcess(1) as never,
    );

    const config = {
      enabled: true,
      prompt: 'Reply exactly OK. Do not run tools.',
      model: 'gpt-5.5',
      intervalMs: 300_000,
      minIntervalMs: 18_300_000,
      staggerMs: 0,
      maxUsagePct: 0,
      maxD7UsagePct: 0,
      commandTimeoutMs: 120_000,
      failureCooldownMs: 21_600_000,
      maxConsecutiveFailures: 1,
    };

    const failed = await runCodexWarmupCycle(config, { nowMs: now, statePath });
    expect(failed.status).toBe('failed');

    const backedOff = await runCodexWarmupCycle(config, {
      nowMs: now + 60_000,
      statePath,
    });

    expect(backedOff).toEqual({
      status: 'skipped',
      reason: 'disabled_cooldown',
    });
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.disabledUntil).toBe('2026-04-24T15:00:00.000Z');
    expect(state.consecutiveFailures).toBe(1);
  });

  it('respects global stagger and does not warm another account too soon', async () => {
    const childProcess = await import('child_process');
    const rotation = await import('./codex-token-rotation.js');
    const { runCodexWarmupCycle } = await import('./codex-warmup.js');
    const now = new Date('2026-04-24T09:20:00Z').getTime();

    fs.writeFileSync(
      statePath,
      JSON.stringify({
        lastWarmupAt: '2026-04-24T09:00:00.000Z',
        consecutiveFailures: 0,
        accounts: { '0': { lastWarmupAt: '2026-04-24T09:00:00.000Z' } },
      }),
    );
    vi.mocked(rotation.getAllCodexAccounts).mockReturnValue([
      {
        index: 1,
        accountId: 'another-fresh-account',
        planType: 'pro',
        isActive: false,
        isRateLimited: false,
        cachedUsagePct: 0,
        cachedUsageD7Pct: 0,
      },
    ]);

    const result = await runCodexWarmupCycle(
      {
        enabled: true,
        prompt: '.',
        model: 'gpt-5.5',
        intervalMs: 300_000,
        minIntervalMs: 18_300_000,
        staggerMs: 1_800_000,
        maxUsagePct: 0,
        maxD7UsagePct: 0,
        commandTimeoutMs: 120_000,
        failureCooldownMs: 21_600_000,
        maxConsecutiveFailures: 2,
      },
      { nowMs: now, statePath },
    );

    expect(result).toEqual({ status: 'skipped', reason: 'stagger_wait' });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
