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
});
