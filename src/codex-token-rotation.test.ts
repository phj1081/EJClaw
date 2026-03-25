import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-error-detection.js', () => ({
  classifyAgentError: vi.fn(() => ({ category: 'none', reason: '' })),
  classifyCodexAuthError: vi.fn(() => ({ category: 'none', reason: '' })),
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
});
