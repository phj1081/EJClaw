import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadEnvFile, mockGetActiveCodexAuthPath } = vi.hoisted(() => ({
  mockReadEnvFile: vi.fn<() => Record<string, string>>(),
  mockGetActiveCodexAuthPath: vi.fn<() => string | null>(),
}));

vi.mock('./config.js', () => ({
  CODEX_REVIEW_SERVICE_ID: 'codex-review',
  GROUPS_DIR: '/tmp/ejclaw-test-groups',
  SERVICE_ID: 'codex-main',
  SERVICE_SESSION_SCOPE: 'codex-main',
  TIMEZONE: 'Asia/Seoul',
  isReviewService: vi.fn(() => false),
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

vi.mock('./service-routing.js', () => ({
  hasReviewerLease: vi.fn(() => false),
  getEffectiveChannelLease: vi.fn(() => ({
    chat_jid: 'dc:test',
    owner_service_id: 'claude',
    reviewer_service_id: 'codex-main',
    arbiter_service_id: null,
    activated_at: null,
    reason: null,
    explicit: false,
  })),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `${process.env.EJ_TEST_ROOT}/groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `${process.env.EJ_TEST_ROOT}/ipc/${folder}`,
  resolveServiceGroupSessionsPath: (folder: string, serviceId: string) =>
    `${process.env.EJ_TEST_ROOT}/sessions/${folder}/services/${serviceId}`,
  resolveTaskRuntimeIpcPath: (folder: string, taskId: string) =>
    `${process.env.EJ_TEST_ROOT}/task-ipc/${folder}/${taskId}`,
  resolveServiceTaskSessionsPath: (
    folder: string,
    serviceId: string,
    taskId: string,
  ) =>
    `${process.env.EJ_TEST_ROOT}/task-sessions/${folder}/${serviceId}/${taskId}`,
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
import * as config from './config.js';
import * as serviceRouting from './service-routing.js';
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

  it('ignores OPENAI_API_KEY and always uses OAuth auth', () => {
    const rotatedAuthPath = path.join(tempRoot, 'rotated-auth.json');
    const rotatedAuth = {
      auth_mode: 'chatgpt',
      tokens: { access_token: 'x' },
    };
    fs.writeFileSync(rotatedAuthPath, JSON.stringify(rotatedAuth));
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
      'services',
      'codex-main',
      '.codex',
      'auth.json',
    );
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as {
      auth_mode: string;
      OPENAI_API_KEY?: string;
      tokens?: unknown;
    };

    // API key auth is never used — always OAuth
    expect(auth.auth_mode).toBe('chatgpt');
    expect(auth.OPENAI_API_KEY).toBeUndefined();
    expect(auth.tokens).toEqual({ access_token: 'x' });
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
      'services',
      'codex-main',
      '.codex',
      'auth.json',
    );
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));

    expect(auth).toEqual(rotatedAuth);
  });

  it('uses the failover owner prompt pack for codex-review when it owns an explicit failover lease', () => {
    vi.mocked(config.isReviewService).mockReturnValue(true);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'dc:test',
      owner_service_id: 'codex-review',
      reviewer_service_id: 'codex-main',
      arbiter_service_id: null,
      activated_at: '2026-03-28T00:00:00.000Z',
      reason: 'claude-429',
      explicit: true,
    });
    mockReadEnvFile.mockReturnValue({});

    const promptsDir = path.join(tempRoot, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'codex-review-platform.md'),
      'review platform prompt\n',
    );
    fs.writeFileSync(
      path.join(promptsDir, 'owner-common-platform.md'),
      'owner common platform prompt\n',
    );
    fs.writeFileSync(
      path.join(promptsDir, 'owner-common-paired-room.md'),
      'owner common paired prompt\n',
    );
    fs.writeFileSync(
      path.join(promptsDir, 'codex-review-failover-platform.md'),
      'failover platform prompt\n',
    );
    prepareGroupEnvironment(
      { ...group, workDir: path.join(tempRoot, 'workdir') },
      false,
      'dc:test',
      {
        memoryBriefing: 'memory briefing',
      },
    );

    const agentsPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.codex',
      'AGENTS.md',
    );
    const agents = fs.readFileSync(agentsPath, 'utf-8');
    const segments = agents.trim().split('\n\n---\n\n');

    expect(segments).toEqual([
      'owner common platform prompt',
      'failover platform prompt',
      'owner common paired prompt',
      'memory briefing',
    ]);
  });

  it('adds only the shared owner prompt fragments to Claude session prompts', () => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    mockReadEnvFile.mockReturnValue({});

    const promptsDir = path.join(tempRoot, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'owner-common-platform.md'),
      'owner common platform prompt\n',
    );
    fs.writeFileSync(
      path.join(promptsDir, 'owner-common-paired-room.md'),
      'owner common paired prompt\n',
    );

    prepareGroupEnvironment(
      { ...group, agentType: 'claude-code' },
      false,
      'dc:test',
      {
        memoryBriefing: 'memory briefing',
      },
    );

    const claudePath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.claude',
      'CLAUDE.md',
    );
    const claude = fs.readFileSync(claudePath, 'utf-8');
    const segments = claude.trim().split('\n\n---\n\n');

    expect(segments).toEqual([
      'owner common platform prompt',
      'platform prompt',
      'owner common paired prompt',
      'memory briefing',
    ]);
  });

  it('returns to the normal owner prompt stack after failover is cleared', () => {
    vi.mocked(config.isReviewService).mockReturnValue(true);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'dc:test',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      arbiter_service_id: null,
      activated_at: null,
      reason: null,
      explicit: false,
    });
    mockReadEnvFile.mockReturnValue({});

    const promptsDir = path.join(tempRoot, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    prepareGroupEnvironment(group, false, 'dc:test');

    const agentsPath = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.codex',
      'AGENTS.md',
    );
    const agents = fs.readFileSync(agentsPath, 'utf-8');
    const segments = agents.trim().split('\n\n---\n\n');

    expect(segments).toEqual(['platform prompt']);
  });
});
