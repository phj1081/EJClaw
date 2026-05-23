import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getCodexFeatures, updateCodexFeatures } from './settings-store.js';

describe('settings-store Codex features', () => {
  let tempDir: string;
  let previousCwd: string;
  let previousCodexGoals: string | undefined;
  let previousCodexConfigPath: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-settings-'));
    previousCwd = process.cwd();
    previousCodexGoals = process.env.CODEX_GOALS;
    previousCodexConfigPath = process.env.EJCLAW_CODEX_CONFIG_PATH;
    delete process.env.CODEX_GOALS;
    process.env.EJCLAW_CODEX_CONFIG_PATH = path.join(tempDir, 'config.toml');
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousCodexGoals === undefined) {
      delete process.env.CODEX_GOALS;
    } else {
      process.env.CODEX_GOALS = previousCodexGoals;
    }
    if (previousCodexConfigPath === undefined) {
      delete process.env.EJCLAW_CODEX_CONFIG_PATH;
    } else {
      process.env.EJCLAW_CODEX_CONFIG_PATH = previousCodexConfigPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores Codex goals in ~/.codex/config.toml [features]', () => {
    expect(getCodexFeatures()).toEqual({ goals: false });

    expect(updateCodexFeatures({ goals: true })).toEqual({ goals: true });
    expect(fs.readFileSync(process.env.EJCLAW_CODEX_CONFIG_PATH!, 'utf-8')).toContain(
      'goals = true',
    );

    expect(updateCodexFeatures({ goals: false })).toEqual({ goals: false });
    expect(fs.readFileSync(process.env.EJCLAW_CODEX_CONFIG_PATH!, 'utf-8')).toContain(
      'goals = false',
    );
  });

  it('still honors legacy CODEX_GOALS=true until migrated', () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'CODEX_GOALS=true\n');
    expect(getCodexFeatures()).toEqual({ goals: true });

    updateCodexFeatures({ goals: false });
    expect(getCodexFeatures()).toEqual({ goals: false });
    expect(fs.readFileSync(path.join(tempDir, '.env'), 'utf-8')).not.toContain(
      'CODEX_GOALS',
    );
  });
});
