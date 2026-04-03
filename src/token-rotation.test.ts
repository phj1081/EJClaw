import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/ejclaw-claude-rot-data',
}));

vi.mock('./env.js', () => ({
  getEnv: vi.fn((key: string) => process.env[key]),
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
    readJsonFile: vi.fn(() => null),
    writeJsonFile: vi.fn(),
  };
});

describe('token-rotation runtime reselection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-02T12:00:00.000Z'));
    process.env.CLAUDE_CODE_OAUTH_TOKENS = 'token-1,token-2';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAUDE_CODE_OAUTH_TOKENS;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('returns to the preferred healthy token after the cooldown expires at runtime', async () => {
    const mod = await import('./token-rotation.js');

    mod.initTokenRotation();
    expect(mod.getCurrentToken()).toBe('token-1');

    expect(mod.rotateToken('rate limit')).toBe(true);
    expect(mod.getCurrentToken()).toBe('token-2');
    expect(mod.getTokenRotationInfo()).toMatchObject({
      total: 2,
      currentIndex: 1,
      rateLimited: 1,
    });

    vi.advanceTimersByTime(60 * 60 * 1000 + 1);

    expect(mod.getCurrentToken()).toBe('token-1');
    expect(mod.getTokenRotationInfo()).toMatchObject({
      total: 2,
      currentIndex: 0,
      rateLimited: 0,
    });
  });
});
