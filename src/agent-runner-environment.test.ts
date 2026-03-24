import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadEnvFile, mockGetActiveCodexAuthPath } = vi.hoisted(() => ({
  mockReadEnvFile: vi.fn<() => Record<string, string>>(),
  mockGetActiveCodexAuthPath: vi.fn<() => string | null>(),
}));

vi.mock('./config.js', () => ({
  GROUPS_DIR: '/tmp/ejclaw-test-groups',
  TIMEZONE: 'Asia/Seoul',
}));

vi.mock('./db.js', () => ({
  isPairedRoomJid: vi.fn(() => false),
}));

vi.mock('./env.js', () => ({
  readEnvFile: mockReadEnvFile,
  getEnv: vi.fn((key: string) => undefined),
}));

vi.mock('./codex-token-rotation.js', () => ({
  getActiveCodexAuthPath: mockGetActiveCodexAuthPath,
}));

vi.mock('./token-rotation.js', () => ({
  getCurrentToken: vi.fn(() => undefined),
}));

vi.mock('./platform-prompts.js', () => ({
  readPlatformPrompt: vi.fn(() => 'platform prompt'),
  readPairedRoomPrompt: vi.fn(() => 'paired room prompt'),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `${process.env.EJ_TEST_ROOT}/groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `${process.env.EJ_TEST_ROOT}/ipc/${folder}`,
  resolveGroupSessionsPath: (folder: string) =>
    `${process.env.EJ_TEST_ROOT}/sessions/${folder}`,
  resolveTaskRuntimeIpcPath: (folder: string, taskId: string) =>
    `${process.env.EJ_TEST_ROOT}/task-ipc/${folder}/${taskId}`,
  resolveTaskSessionsPath: (folder: string, taskId: string) =>
    `${process.env.EJ_TEST_ROOT}/task-sessions/${folder}/${taskId}`,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => process.env.EJ_TEST_HOME || '/tmp',
    },
    homedir: () => process.env.EJ_TEST_HOME || '/tmp',
  };
});

import { prepareGroupEnvironment } from './agent-runner-environment.js';
import type { RegisteredGroup } from './types.js';

const group: RegisteredGroup = {
  name: 'Codex Test Group',
  folder: 'codex-test-group',
  trigger: '@Codex',
  added_at: new Date().toISOString(),
  agentType: 'codex',
};

describe('prepareGroupEnvironment codex auth handling', () => {
  let tempRoot: string;
  let previousCwd: string;
  let previousOpenAiKey: string | undefined;
  let previousCodexOpenAiKey: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'ejclaw-agent-env-'));
    previousCwd = process.cwd();
    process.chdir(tempRoot);

    process.env.EJ_TEST_ROOT = tempRoot;
    process.env.EJ_TEST_HOME = path.join(tempRoot, 'home');
    previousOpenAiKey = process.env.OPENAI_API_KEY;
    previousCodexOpenAiKey = process.env.CODEX_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_OPENAI_API_KEY;

    fs.mkdirSync(process.env.EJ_TEST_HOME, { recursive: true });
    fs.mkdirSync(path.join(process.env.EJ_TEST_HOME, '.codex'), {
      recursive: true,
    });

    mockReadEnvFile.mockReset();
    mockGetActiveCodexAuthPath.mockReset();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    delete process.env.EJ_TEST_ROOT;
    delete process.env.EJ_TEST_HOME;
    if (previousOpenAiKey) process.env.OPENAI_API_KEY = previousOpenAiKey;
    else delete process.env.OPENAI_API_KEY;
    if (previousCodexOpenAiKey) {
      process.env.CODEX_OPENAI_API_KEY = previousCodexOpenAiKey;
    } else {
      delete process.env.CODEX_OPENAI_API_KEY;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('writes API-key auth when OPENAI_API_KEY is available', () => {
    const rotatedAuthPath = path.join(tempRoot, 'rotated-auth.json');
    fs.writeFileSync(
      rotatedAuthPath,
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }),
    );
    mockGetActiveCodexAuthPath.mockReturnValue(rotatedAuthPath);
    mockReadEnvFile.mockReturnValue({
      OPENAI_API_KEY: 'sk-test-api-key',
      CODEX_MODEL: 'gpt-5.4',
    });

    prepareGroupEnvironment(group, false, 'dc:test');

    const authPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      '.codex',
      'auth.json',
    );
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as {
      auth_mode: string;
      OPENAI_API_KEY?: string;
      tokens?: unknown;
    };

    expect(auth.auth_mode).toBe('apikey');
    expect(auth.OPENAI_API_KEY).toBe('sk-test-api-key');
    expect(auth.tokens).toBeUndefined();
  });

  it('falls back to rotated OAuth auth when no API key is configured', () => {
    const rotatedAuthPath = path.join(tempRoot, 'rotated-auth.json');
    const rotatedAuth = {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'oauth-access',
        refresh_token: 'oauth-refresh',
      },
    };
    fs.writeFileSync(rotatedAuthPath, JSON.stringify(rotatedAuth));
    mockGetActiveCodexAuthPath.mockReturnValue(rotatedAuthPath);
    mockReadEnvFile.mockReturnValue({});

    prepareGroupEnvironment(group, false, 'dc:test');

    const authPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      '.codex',
      'auth.json',
    );
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));

    expect(auth).toEqual(rotatedAuth);
  });
});
