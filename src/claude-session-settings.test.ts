import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureClaudeSessionSettings } from './claude-session-settings.js';

describe('claude-session-settings', () => {
  let tempDir: string;
  let hostSettingsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-claude-settings-'));
    hostSettingsPath = path.join(tempDir, 'host-settings.json');
    process.env.EJCLAW_CLAUDE_SETTINGS_PATH = hostSettingsPath;
  });

  afterEach(() => {
    delete process.env.EJCLAW_CLAUDE_SETTINGS_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('syncs host fastMode into the Claude session settings file', () => {
    fs.writeFileSync(
      hostSettingsPath,
      `${JSON.stringify({ fastMode: true }, null, 2)}\n`,
    );

    const sessionDir = path.join(tempDir, 'session');
    ensureClaudeSessionSettings(sessionDir);

    const session = JSON.parse(
      fs.readFileSync(path.join(sessionDir, 'settings.json'), 'utf-8'),
    ) as { fastMode?: boolean; env?: Record<string, string> };
    expect(session.fastMode).toBe(true);
    expect(session.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });
});
