import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-error-detection.js', () => ({
  classifyAgentError: vi.fn(() => ({ category: 'none', reason: '' })),
  classifyCodexAuthError: vi.fn(() => ({ category: 'none', reason: '' })),
  isCodexPoolUnavailableError: vi.fn(
    (error: string | null | undefined) =>
      /all\s+codex(?:\s+rotation)?\s+accounts(?:\s+are)?\s+unavailable/i.test(
        error ?? '',
      ) || /codex\s+rotation\s+pool\s+unavailable/i.test(error ?? ''),
  ),
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/ejclaw-codex-rot-data',
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./utils.js', async () => {
  const actual =
    await vi.importActual<typeof import('./utils.js')>('./utils.js');
  return {
    ...actual,
    writeJsonFile: vi.fn(), // no-op to prevent state file writes
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => process.env.CODEX_ROT_TEST_HOME || '/tmp',
    },
    homedir: () => process.env.CODEX_ROT_TEST_HOME || '/tmp',
  };
});

function createFakeAccounts(homeDir: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const dir = path.join(homeDir, '.codex-accounts', String(i));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { account_id: `acct-${i}`, access_token: `token-${i}` },
      }),
    );
  }
}

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

describe('codex-token-rotation d7 ≥ 100% auto-skip', () => {
  let tempHome: string;

  beforeEach(() => {
    vi.resetModules();
    tempHome = fs.mkdtempSync(path.join('/tmp', 'ejclaw-codex-rot-'));
    process.env.CODEX_ROT_TEST_HOME = tempHome;
    createFakeAccounts(tempHome, 4);
  });

  afterEach(() => {
    delete process.env.CODEX_ROT_TEST_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('advanceCodexAccount skips accounts with d7 ≥ 100%', async () => {
    const mod = await import('./codex-token-rotation.js');
    mod.initCodexTokenRotation();
    expect(mod.getCodexAccountCount()).toBe(4);

    // Mark account #1 (next after #0) as 7d-exhausted
    mod.updateCodexAccountUsage(80, undefined, 1, 100, undefined);

    // Current is #0, advance should skip #1 (d7=100%) → land on #2
    mod.advanceCodexAccount();

    const accounts = mod.getAllCodexAccounts();
    expect(accounts[0].isActive).toBe(false);
    expect(accounts[1].isActive).toBe(false);
    expect(accounts[2].isActive).toBe(true);
  });

  it('updateCodexAccountUsage auto-rotates when current account hits d7 ≥ 100%', async () => {
    const mod = await import('./codex-token-rotation.js');
    mod.initCodexTokenRotation();
    expect(mod.getCodexAccountCount()).toBe(4);

    // Current is #0 — report d7=100% for the current account
    mod.updateCodexAccountUsage(80, undefined, 0, 100, undefined);

    // Should have auto-rotated away from #0 to #1
    const accounts = mod.getAllCodexAccounts();
    expect(accounts[0].isActive).toBe(false);
    expect(accounts[1].isActive).toBe(true);
  });

  it('advanceCodexAccount falls back when all accounts are d7-exhausted', async () => {
    const mod = await import('./codex-token-rotation.js');
    mod.initCodexTokenRotation();
    expect(mod.getCodexAccountCount()).toBe(4);

    // Exhaust d7 on all accounts except current (#0)
    mod.updateCodexAccountUsage(80, undefined, 1, 100, undefined);
    mod.updateCodexAccountUsage(80, undefined, 2, 100, undefined);
    mod.updateCodexAccountUsage(80, undefined, 3, 100, undefined);

    // Advance — all others d7-exhausted, falls back to rate-limit-only check
    // findNextAvailable (base) should still find #1 since it's not rate-limited
    mod.advanceCodexAccount();

    const accounts = mod.getAllCodexAccounts();
    const active = accounts.find((a) => a.isActive);
    expect(active).toBeDefined();
    expect(active!.index).toBe(1); // fallback picks next non-rate-limited
  });

  it('warns when Codex rotation state cannot be persisted', async () => {
    const mod = await import('./codex-token-rotation.js');
    const utils = await import('./utils.js');
    const { logger } = await import('./logger.js');

    vi.mocked(utils.writeJsonFile).mockImplementation(() => {
      throw new Error('disk full');
    });

    mod.initCodexTokenRotation();
    expect(mod.rotateCodexToken('rate limit')).toBe(true);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        stateFile: '/tmp/ejclaw-codex-rot-data/codex-rotation-state.json',
        err: expect.any(Error),
      }),
      'Failed to persist Codex rotation state',
    );
  });

  it('does not append ~/.codex/auth.json fallback when numbered accounts exist', async () => {
    const fallbackAuthPath = createDefaultCodexAuth(tempHome);

    const mod = await import('./codex-token-rotation.js');
    mod.initCodexTokenRotation();

    expect(mod.getCodexAccountCount()).toBe(4);
    expect(mod.getActiveCodexAuthPath()).not.toBe(fallbackAuthPath);
  });

  it('does not mutate account health for the internal all-accounts-unavailable sentinel', async () => {
    const agentErrors = await import('./agent-error-detection.js');
    vi.mocked(agentErrors.classifyCodexAuthError).mockReturnValueOnce({
      category: 'auth-expired',
      reason: 'auth-expired',
    });

    const mod = await import('./codex-token-rotation.js');
    mod.initCodexTokenRotation();

    expect(
      mod.rotateCodexToken(
        'auth-expired: All Codex rotation accounts unavailable; re-auth required before launching Codex',
      ),
    ).toBe(false);

    const accounts = mod.getAllCodexAccounts();
    expect(accounts[0]).toEqual(
      expect.objectContaining({
        isActive: true,
        isAuthDead: false,
        authStatus: 'healthy',
        isRateLimited: false,
      }),
    );
    expect(accounts[1].isActive).toBe(false);
  });

  it('marks refresh-token reuse as dead auth instead of a recoverable cooldown', async () => {
    const agentErrors = await import('./agent-error-detection.js');
    vi.mocked(agentErrors.classifyCodexAuthError).mockReturnValueOnce({
      category: 'auth-expired',
      reason: 'auth-expired',
    });

    const mod = await import('./codex-token-rotation.js');
    mod.initCodexTokenRotation();

    expect(mod.rotateCodexToken('refresh token was already used')).toBe(true);

    const accounts = mod.getAllCodexAccounts();
    expect(accounts[0]).toEqual(
      expect.objectContaining({
        isAuthDead: true,
        authStatus: 'dead_auth',
      }),
    );
    expect(accounts[0].isRateLimited).toBe(false);
    expect(accounts[1].isActive).toBe(true);
  });
});

describe('codex-token-rotation auth synchronization', () => {
  let tempHome: string;

  beforeEach(() => {
    vi.resetModules();
    tempHome = fs.mkdtempSync(path.join('/tmp', 'ejclaw-codex-rot-'));
    process.env.CODEX_ROT_TEST_HOME = tempHome;
    createFakeAccounts(tempHome, 4);
  });

  afterEach(() => {
    delete process.env.CODEX_ROT_TEST_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('recovers a dead_auth account when canonical auth.json is refreshed before lease claim', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const agentErrors = await import('./agent-error-detection.js');
      vi.mocked(agentErrors.classifyCodexAuthError).mockReturnValueOnce({
        category: 'auth-expired',
        reason: 'auth-expired',
      });

      const mod = await import('./codex-token-rotation.js');
      const utils = await import('./utils.js');
      mod.initCodexTokenRotation();

      expect(mod.rotateCodexToken('refresh token was already used')).toBe(true);
      expect(mod.getAllCodexAccounts()[0].isAuthDead).toBe(true);

      const refreshedAt = new Date('2026-01-01T00:00:10.000Z');
      const authPath = path.join(tempHome, '.codex-accounts', '0', 'auth.json');
      fs.writeFileSync(
        authPath,
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: { account_id: 'acct-0', access_token: 'refreshed-token' },
        }),
      );
      fs.utimesSync(authPath, refreshedAt, refreshedAt);

      mod.setCurrentCodexAccountIndex(0);
      const lease = mod.claimCodexAuthLease();
      try {
        expect(lease).toEqual(
          expect.objectContaining({ accountIndex: 0, authPath }),
        );
        expect(mod.getAllCodexAccounts()[0]).toEqual(
          expect.objectContaining({
            authStatus: 'healthy',
            isAuthDead: false,
            isActive: true,
          }),
        );
        expect(vi.mocked(utils.writeJsonFile)).toHaveBeenCalled();
      } finally {
        lease?.release();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('leases different accounts for concurrent Codex runs', async () => {
    const mod = await import('./codex-token-rotation.js');
    mod.initCodexTokenRotation();

    const first = mod.claimCodexAuthLease();
    const second = mod.claimCodexAuthLease();

    try {
      expect(first).toEqual(
        expect.objectContaining({
          accountIndex: 0,
          authPath: expect.any(String),
        }),
      );
      expect(second).toEqual(
        expect.objectContaining({
          accountIndex: 1,
          authPath: expect.any(String),
        }),
      );
      expect(second?.authPath).not.toBe(first?.authPath);
    } finally {
      second?.release();
      first?.release();
    }
  });

  it('syncs a refreshed session auth.json back to the canonical slot atomically', async () => {
    const mod = await import('./codex-token-rotation.js');
    mod.initCodexTokenRotation();

    const canonicalAuthPath = path.join(
      tempHome,
      '.codex-accounts',
      '0',
      'auth.json',
    );
    const sessionAuthPath = path.join(
      tempHome,
      'session',
      '.codex',
      'auth.json',
    );
    fs.mkdirSync(path.dirname(sessionAuthPath), { recursive: true });
    fs.writeFileSync(
      sessionAuthPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          account_id: 'acct-0',
          access_token: 'new-access',
          refresh_token: 'new-refresh',
        },
      }),
    );

    const synced = mod.syncCodexSessionAuthBack({
      canonicalAuthPath,
      sessionAuthPath,
      accountIndex: 0,
    });

    expect(synced).toBe(true);
    const canonical = JSON.parse(fs.readFileSync(canonicalAuthPath, 'utf-8'));
    expect(canonical.tokens).toEqual(
      expect.objectContaining({
        account_id: 'acct-0',
        access_token: 'new-access',
        refresh_token: 'new-refresh',
      }),
    );
  });

  it('refuses to sync a session auth.json that belongs to another Codex account', async () => {
    const mod = await import('./codex-token-rotation.js');
    mod.initCodexTokenRotation();

    const canonicalAuthPath = path.join(
      tempHome,
      '.codex-accounts',
      '0',
      'auth.json',
    );
    const before = fs.readFileSync(canonicalAuthPath, 'utf-8');
    const sessionAuthPath = path.join(
      tempHome,
      'wrong-account',
      '.codex',
      'auth.json',
    );
    fs.mkdirSync(path.dirname(sessionAuthPath), { recursive: true });
    fs.writeFileSync(
      sessionAuthPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          account_id: 'acct-other',
          access_token: 'other-access',
          refresh_token: 'other-refresh',
        },
      }),
    );

    expect(
      mod.syncCodexSessionAuthBack({
        canonicalAuthPath,
        sessionAuthPath,
        accountIndex: 0,
      }),
    ).toBe(false);
    expect(fs.readFileSync(canonicalAuthPath, 'utf-8')).toBe(before);
  });
});

describe('codex-token-rotation single-account fallback', () => {
  let tempHome: string;

  beforeEach(() => {
    vi.resetModules();
    tempHome = fs.mkdtempSync(path.join('/tmp', 'ejclaw-codex-fallback-'));
    process.env.CODEX_ROT_TEST_HOME = tempHome;
  });

  afterEach(() => {
    delete process.env.CODEX_ROT_TEST_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('uses ~/.codex/auth.json fallback when ~/.codex-accounts is absent', async () => {
    const fallbackAuthPath = createDefaultCodexAuth(tempHome);

    const mod = await import('./codex-token-rotation.js');
    mod.initCodexTokenRotation();

    expect(mod.getCodexAccountCount()).toBe(1);
    expect(mod.getActiveCodexAuthPath()).toBe(fallbackAuthPath);
    expect(mod.getAllCodexAccounts()).toEqual([
      expect.objectContaining({
        index: 0,
        accountId: 'default-acct',
        isActive: true,
      }),
    ]);
  });
});
