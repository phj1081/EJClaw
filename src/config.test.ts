import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('config/env loading', () => {
  let tempRoot: string;
  let previousCwd: string;
  let previousEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'ejclaw-config-'));
    previousCwd = process.cwd();
    previousEnv = { ...process.env };
    process.chdir(tempRoot);
    delete process.env.EJCLAW_STORE_DIR;
    delete process.env.EJCLAW_GROUPS_DIR;
    delete process.env.EJCLAW_DATA_DIR;
    delete process.env.EJCLAW_CACHE_DIR;
    delete process.env.AGENT_TIMEOUT;
    delete process.env.LOG_LEVEL;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CODEX_MODEL;
    delete process.env.STATUS_CHANNEL_ID;
    delete process.env.TZ;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_CLAUDE_BOT_TOKEN;
    delete process.env.DISCORD_CODEX_BOT_TOKEN;
    delete process.env.DISCORD_CODEX_MAIN_BOT_TOKEN;
    delete process.env.DISCORD_REVIEW_BOT_TOKEN;
    delete process.env.DISCORD_CODEX_REVIEW_BOT_TOKEN;
    delete process.env.PAIRED_CARRY_FORWARD_LATEST_OWNER_FINAL;
    delete process.env.PAIRED_FORCE_FRESH_CLAUDE_REVIEWER_SESSION;
    delete process.env.CODEX_WARMUP_ENABLED;
    delete process.env.CODEX_WARMUP_PROMPT;
    delete process.env.CODEX_WARMUP_MODEL;
    delete process.env.CODEX_WARMUP_INTERVAL_MS;
    delete process.env.CODEX_WARMUP_MIN_INTERVAL_MS;
    delete process.env.CODEX_WARMUP_STAGGER_MS;
    delete process.env.CODEX_WARMUP_MAX_USAGE_PCT;
    delete process.env.CODEX_WARMUP_MAX_D7_USAGE_PCT;
    delete process.env.CODEX_WARMUP_COMMAND_TIMEOUT_MS;
    delete process.env.CODEX_WARMUP_FAILURE_COOLDOWN_MS;
    delete process.env.CODEX_WARMUP_MAX_CONSECUTIVE_FAILURES;
    delete process.env.WEB_DASHBOARD_ENABLED;
    delete process.env.WEB_DASHBOARD_HOST;
    delete process.env.WEB_DASHBOARD_PORT;
    delete process.env.WEB_DASHBOARD_STATIC_DIR;
    delete process.env.SESSION_COMMAND_USER_IDS;
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('preserves empty-string env values and still prefers process.env over .env', async () => {
    fs.writeFileSync(
      path.join(tempRoot, '.env'),
      [
        'FROM_FILE=file-value',
        'EMPTY_IN_FILE=',
        'PROCESS_EMPTY=file-fallback',
      ].join('\n'),
    );
    process.env.FROM_FILE = 'process-value';
    process.env.PROCESS_EMPTY = '';

    const env = await import('./env.js');

    expect(env.getEnv('FROM_FILE')).toBe('process-value');
    expect(env.getEnv('EMPTY_IN_FILE')).toBe('');
    expect(env.getEnv('PROCESS_EMPTY')).toBe('');
    expect(env.readEnvFile(['EMPTY_IN_FILE', 'PROCESS_EMPTY'])).toEqual({
      EMPTY_IN_FILE: '',
      PROCESS_EMPTY: 'file-fallback',
    });
  });

  it('loads formerly process-only config values through the shared env path', async () => {
    fs.writeFileSync(
      path.join(tempRoot, '.env'),
      [
        'EJCLAW_STORE_DIR=./custom-store',
        'EJCLAW_GROUPS_DIR=./custom-groups',
        'EJCLAW_DATA_DIR=./custom-data',
        'EJCLAW_CACHE_DIR=./custom-cache',
        'AGENT_TIMEOUT=12345',
        'LOG_LEVEL=trace',
        'CLAUDE_MODEL=claude-opus-test',
        'CODEX_MODEL=gpt-5.4-test',
        'STATUS_CHANNEL_ID=status-room',
        'TZ=UTC',
      ].join('\n'),
    );

    const config = await import('./config.js');

    expect(config.STORE_DIR).toBe(path.resolve(tempRoot, 'custom-store'));
    expect(config.GROUPS_DIR).toBe(path.resolve(tempRoot, 'custom-groups'));
    expect(config.DATA_DIR).toBe(path.resolve(tempRoot, 'custom-data'));
    expect(config.CACHE_DIR).toBe(path.resolve(tempRoot, 'custom-cache'));
    expect(config.AGENT_TIMEOUT).toBe(12345);
    expect(config.LOG_LEVEL).toBe('trace');
    expect(config.DEFAULT_CLAUDE_MODEL).toBe('claude-opus-test');
    expect(config.DEFAULT_CODEX_MODEL).toBe('gpt-5.4-test');
    expect(config.STATUS_CHANNEL_ID).toBe('status-room');
    expect(config.TIMEZONE).toBe('UTC');
  });

  it('defaults latest-owner-final carry-forward to disabled and honors explicit opt-in', async () => {
    let config = await import('./config.js');
    expect(config.PAIRED_CARRY_FORWARD_LATEST_OWNER_FINAL).toBe(false);

    vi.resetModules();
    process.env.PAIRED_CARRY_FORWARD_LATEST_OWNER_FINAL = 'true';
    config = await import('./config.js');
    expect(config.PAIRED_CARRY_FORWARD_LATEST_OWNER_FINAL).toBe(true);
  });

  it('defaults unsafe-host Claude reviewer fresh-session forcing to disabled and honors explicit opt-in', async () => {
    let config = await import('./config.js');
    expect(config.PAIRED_FORCE_FRESH_CLAUDE_REVIEWER_SESSION).toBe(false);

    vi.resetModules();
    process.env.PAIRED_FORCE_FRESH_CLAUDE_REVIEWER_SESSION = 'true';
    config = await import('./config.js');
    expect(config.PAIRED_FORCE_FRESH_CLAUDE_REVIEWER_SESSION).toBe(true);
  });

  it('keeps Codex warm-up disabled by default and exposes conservative opt-in env config', async () => {
    let config = await import('./config.js');
    expect(config.CODEX_WARMUP_CONFIG.enabled).toBe(false);
    expect(config.CODEX_WARMUP_CONFIG.maxUsagePct).toBe(0);
    expect(config.CODEX_WARMUP_CONFIG.maxD7UsagePct).toBe(0);
    expect(
      config.CODEX_WARMUP_CONFIG.maxConsecutiveFailures,
    ).toBeGreaterThanOrEqual(1);

    vi.resetModules();
    process.env.CODEX_MODEL = 'gpt-5.5';
    process.env.CODEX_WARMUP_ENABLED = 'true';
    process.env.CODEX_WARMUP_PROMPT = '.';
    process.env.CODEX_WARMUP_STAGGER_MS = '600000';
    process.env.CODEX_WARMUP_MAX_CONSECUTIVE_FAILURES = '1';
    config = await import('./config.js');

    expect(config.CODEX_WARMUP_CONFIG).toEqual(
      expect.objectContaining({
        enabled: true,
        prompt: '.',
        model: 'gpt-5.5',
        staggerMs: 600000,
        maxConsecutiveFailures: 1,
      }),
    );
  });

  it('keeps the web dashboard disabled by default and loads explicit bind/static settings', async () => {
    let config = await import('./config.js');
    expect(config.WEB_DASHBOARD.enabled).toBe(false);
    expect(config.WEB_DASHBOARD.host).toBe('127.0.0.1');
    expect(config.WEB_DASHBOARD.port).toBe(8734);
    expect(config.WEB_DASHBOARD.staticDir).toBe(
      path.resolve(tempRoot, 'apps', 'dashboard', 'dist'),
    );

    vi.resetModules();
    process.env.WEB_DASHBOARD_ENABLED = 'true';
    process.env.WEB_DASHBOARD_HOST = '0.0.0.0';
    process.env.WEB_DASHBOARD_PORT = '9001';
    process.env.WEB_DASHBOARD_STATIC_DIR = './custom-dashboard-dist';
    config = await import('./config.js');

    expect(config.WEB_DASHBOARD).toEqual({
      enabled: true,
      host: '0.0.0.0',
      port: 9001,
      staticDir: path.resolve(tempRoot, 'custom-dashboard-dist'),
    });
  });

  it('fails fast when a legacy Discord token alias is configured', async () => {
    process.env.DISCORD_BOT_TOKEN = 'legacy...oken';

    const { loadConfig } = await import('./config/load-config.js');

    expect(() => loadConfig()).toThrow(
      /Legacy env aliases are no longer supported; remove or rename \(DISCORD_BOT_TOKEN\) to the canonical keys/,
    );
  });

  it('fails fast when SESSION_COMMAND_USER_IDS is configured', async () => {
    process.env.SESSION_COMMAND_USER_IDS = 'alice,bob';

    const { loadConfig } = await import('./config/load-config.js');

    expect(() => loadConfig()).toThrow(
      /Legacy env aliases are no longer supported; remove or rename \(SESSION_COMMAND_USER_IDS\) to the canonical keys/,
    );
  });
});
