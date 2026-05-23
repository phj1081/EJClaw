import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CLAUDE_SESSION_ENV = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
} as const;

function settingsHomeDir(): string {
  return process.env.EJCLAW_SETTINGS_HOME || os.homedir();
}

export function claudeHostSettingsPath(): string {
  const override = process.env.EJCLAW_CLAUDE_SETTINGS_PATH?.trim();
  if (override) return override;
  return path.join(settingsHomeDir(), '.claude', 'settings.json');
}

export function readHostClaudeFastMode(): boolean {
  const file = claudeHostSettingsPath();
  if (!fs.existsSync(file)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<
      string,
      unknown
    >;
    return data.fastMode === true;
  } catch {
    return false;
  }
}

export function ensureClaudeSessionSettings(groupSessionsDir: string): void {
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  let data: Record<string, unknown> = {
    env: { ...DEFAULT_CLAUDE_SESSION_ENV },
  };

  if (fs.existsSync(settingsFile)) {
    try {
      const existing = JSON.parse(
        fs.readFileSync(settingsFile, 'utf-8'),
      ) as Record<string, unknown>;
      data = {
        ...existing,
        env: {
          ...DEFAULT_CLAUDE_SESSION_ENV,
          ...(typeof existing.env === 'object' && existing.env !== null
            ? (existing.env as Record<string, unknown>)
            : {}),
        },
      };
    } catch {
      data = { env: { ...DEFAULT_CLAUDE_SESSION_ENV } };
    }
  }

  if (readHostClaudeFastMode()) {
    data.fastMode = true;
  } else {
    delete data.fastMode;
  }

  fs.mkdirSync(groupSessionsDir, { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify(data, null, 2)}\n`);
}
