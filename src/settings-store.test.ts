import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getCodexFeatures, updateCodexFeatures } from './settings-store.js';

describe('settings-store Codex features', () => {
  let tempDir: string;
  let previousCwd: string;
  let previousCodexGoals: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-settings-'));
    previousCwd = process.cwd();
    previousCodexGoals = process.env.CODEX_GOALS;
    delete process.env.CODEX_GOALS;
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousCodexGoals === undefined) {
      delete process.env.CODEX_GOALS;
    } else {
      process.env.CODEX_GOALS = previousCodexGoals;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores the Codex goals opt-in in the EJClaw .env file', () => {
    expect(getCodexFeatures()).toEqual({ goals: false });

    expect(updateCodexFeatures({ goals: true })).toEqual({ goals: true });
    expect(fs.readFileSync(path.join(tempDir, '.env'), 'utf-8')).toContain(
      'CODEX_GOALS=true',
    );

    expect(updateCodexFeatures({ goals: false })).toEqual({ goals: false });
    expect(fs.readFileSync(path.join(tempDir, '.env'), 'utf-8')).toContain(
      'CODEX_GOALS=false',
    );
  });
});
