import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadEnvFile, mockGetActiveCodexAuthPath } = vi.hoisted(() => ({
  mockReadEnvFile: vi.fn<() => Record<string, string>>(),
  mockGetActiveCodexAuthPath: vi.fn<() => string | null>(),
}));

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  CODEX_REVIEW_SERVICE_ID: 'codex-review',
  GROUPS_DIR: '/tmp/ejclaw-test-groups',
  IS_TEST_ENV: true,
  LOG_LEVEL: 'info',
  SERVICE_ID: 'codex-main',
  SERVICE_SESSION_SCOPE: 'codex-main',
  TIMEZONE: 'Asia/Seoul',
  isReviewService: vi.fn(() => false),
}));

vi.mock('./env.js', () => ({
  readEnvFile: mockReadEnvFile,
  getEnv: vi.fn((_key: string) => undefined),
}));

vi.mock('./codex-token-rotation.js', () => ({
  getActiveCodexAuthPath: mockGetActiveCodexAuthPath,
}));

vi.mock('./token-rotation.js', () => ({
  getCurrentToken: vi.fn(() => undefined),
  getConfiguredClaudeTokens: vi.fn(
    (options?: { multi?: string | undefined; single?: string | undefined }) => {
      if (options?.multi) {
        return options.multi
          .split(',')
          .map((token) => token.trim())
          .filter(Boolean);
      }
      return options?.single ? [options.single] : [];
    },
  ),
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
    owner_failover_active: false,
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

import {
  prepareReadonlySessionEnvironment,
  prepareGroupEnvironment,
} from './agent-runner-environment.js';
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

function writeSkill(dir: string, name: string): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n`,
  );
}

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
      reviewer_service_id: 'claude',
      arbiter_service_id: null,
      owner_failover_active: true,
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

  it('maps the canonical multi-token env to a single runner OAuth token', () => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    mockReadEnvFile.mockReturnValue({
      CLAUDE_CODE_OAUTH_TOKENS: 'token-a, token-b',
    });

    const prepared = prepareGroupEnvironment(
      { ...group, agentType: 'claude-code' },
      false,
      'dc:test',
    );

    expect(prepared.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-a');
  });

  it('returns to the normal owner prompt stack after failover is cleared', () => {
    vi.mocked(config.isReviewService).mockReturnValue(true);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'dc:test',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      arbiter_service_id: null,
      owner_failover_active: false,
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

describe('prepareGroupEnvironment room skill overrides', () => {
  let tempRoot: string;
  let previousCwd: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'ejclaw-agent-skills-'));
    previousCwd = process.cwd();
    process.chdir(tempRoot);
    process.env.EJ_TEST_ROOT = tempRoot;
    process.env.EJ_TEST_HOME = path.join(tempRoot, 'home');
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
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('filters Claude session skills with room overrides at spawn time', () => {
    mockReadEnvFile.mockReturnValue({});
    const homeSkills = path.join(
      process.env.EJ_TEST_HOME!,
      '.claude',
      'skills',
    );
    const workDir = path.join(tempRoot, 'workdir');
    const runnerSkills = path.join(tempRoot, 'runners', 'skills');
    writeSkill(homeSkills, 'claude-keep');
    writeSkill(path.join(workDir, '.claude', 'skills'), 'workdir-keep');
    writeSkill(runnerSkills, 'runner-keep');
    writeSkill(runnerSkills, 'runner-off');

    prepareGroupEnvironment(
      { ...group, agentType: 'claude-code', workDir },
      false,
      'dc:test',
      {
        skillOverrides: [
          {
            chatJid: 'dc:test',
            agentType: 'claude-code',
            skillScope: 'runner',
            skillName: 'runner-off',
            enabled: false,
            createdAt: '2026-05-04T00:00:00.000Z',
            updatedAt: '2026-05-04T00:00:00.000Z',
          },
        ],
      },
    );

    const sessionSkills = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
      '.claude',
      'skills',
    );
    expect(fs.existsSync(path.join(sessionSkills, 'claude-keep'))).toBe(true);
    expect(fs.existsSync(path.join(sessionSkills, 'workdir-keep'))).toBe(true);
    expect(fs.existsSync(path.join(sessionSkills, 'runner-keep'))).toBe(true);
    expect(fs.existsSync(path.join(sessionSkills, 'runner-off'))).toBe(false);
  });

  it('uses a session-scoped Codex home when room overrides disable skills', () => {
    mockReadEnvFile.mockReturnValue({});
    const codexSkills = path.join(
      process.env.EJ_TEST_HOME!,
      '.agents',
      'skills',
    );
    const runnerSkills = path.join(tempRoot, 'runners', 'skills');
    writeSkill(codexSkills, 'codex-keep');
    writeSkill(codexSkills, 'codex-off');
    writeSkill(runnerSkills, 'runner-keep');
    writeSkill(runnerSkills, 'runner-off');

    const prepared = prepareGroupEnvironment(group, false, 'dc:test', {
      skillOverrides: [
        {
          chatJid: 'dc:test',
          agentType: 'codex',
          skillScope: 'codex-user',
          skillName: 'codex-off',
          enabled: false,
          createdAt: '2026-05-04T00:00:00.000Z',
          updatedAt: '2026-05-04T00:00:00.000Z',
        },
        {
          chatJid: 'dc:test',
          agentType: 'codex',
          skillScope: 'runner',
          skillName: 'runner-off',
          enabled: false,
          createdAt: '2026-05-04T00:00:00.000Z',
          updatedAt: '2026-05-04T00:00:00.000Z',
        },
      ],
    });

    const sessionRoot = path.join(
      tempRoot,
      'sessions',
      group.folder,
      'services',
      'codex-main',
    );
    const sessionHome = path.join(sessionRoot, 'home');
    const sessionSkills = path.join(sessionHome, '.agents', 'skills');
    expect(prepared.env.HOME).toBe(sessionHome);
    expect(prepared.env.CODEX_HOME).toBe(path.join(sessionRoot, '.codex'));
    expect(fs.existsSync(path.join(sessionSkills, 'codex-keep'))).toBe(true);
    expect(fs.existsSync(path.join(sessionSkills, 'runner-keep'))).toBe(true);
    expect(fs.existsSync(path.join(sessionSkills, 'codex-off'))).toBe(false);
    expect(fs.existsSync(path.join(sessionSkills, 'runner-off'))).toBe(false);
    expect(fs.existsSync(path.join(codexSkills, 'codex-off'))).toBe(true);
  });
});

describe('prepareGroupEnvironment Codex goals handling', () => {
  let tempRoot: string;
  let previousCwd: string;
  let previousCodexGoals: string | undefined;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'ejclaw-agent-env-goals-'));
    previousCwd = process.cwd();
    previousCodexGoals = process.env.CODEX_GOALS;
    process.chdir(tempRoot);
    process.env.EJ_TEST_ROOT = tempRoot;
    process.env.EJ_TEST_HOME = path.join(tempRoot, 'home');
    delete process.env.CODEX_GOALS;

    fs.mkdirSync(path.join(process.env.EJ_TEST_HOME, '.codex'), {
      recursive: true,
    });

    mockReadEnvFile.mockReset();
    mockGetActiveCodexAuthPath.mockReset();
    vi.mocked(config.isReviewService).mockReturnValue(false);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(false);
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: 'dc:test',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      arbiter_service_id: null,
      owner_failover_active: false,
      activated_at: null,
      reason: null,
      explicit: false,
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    delete process.env.EJ_TEST_ROOT;
    delete process.env.EJ_TEST_HOME;
    if (previousCodexGoals) process.env.CODEX_GOALS = previousCodexGoals;
    else delete process.env.CODEX_GOALS;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps Codex goals disabled by default and enables them only via opt-in config', () => {
    mockReadEnvFile.mockReturnValue({});

    const defaultPrepared = prepareGroupEnvironment(group, false, 'dc:test');
    expect(defaultPrepared.env.CODEX_GOALS).toBeUndefined();

    const enabledPrepared = prepareGroupEnvironment(
      {
        ...group,
        agentConfig: {
          codexGoals: true,
        },
      },
      false,
      'dc:test',
    );
    expect(enabledPrepared.env.CODEX_GOALS).toBe('true');
  });

  it('allows CODEX_GOALS env opt-in for Codex runner sessions', () => {
    mockReadEnvFile.mockReturnValue({
      CODEX_GOALS: 'true',
    });

    const prepared = prepareGroupEnvironment(group, false, 'dc:test');

    expect(prepared.env.CODEX_GOALS).toBe('true');
  });
});

describe('prepareReadonlySessionEnvironment codex compatibility', () => {
  let tempRoot: string;
  let previousCwd: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'ejclaw-readonly-env-'));
    previousCwd = process.cwd();
    process.chdir(tempRoot);

    process.env.EJ_TEST_ROOT = tempRoot;
    process.env.EJ_TEST_HOME = path.join(tempRoot, 'home');

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
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('writes matching AGENTS.md and copies host codex auth/config into the role-scoped session', () => {
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);

    const promptsDir = path.join(tempRoot, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    const mcpServerPath = path.join(
      tempRoot,
      'runners',
      'agent-runner',
      'dist',
      'ipc-mcp-stdio.js',
    );
    fs.mkdirSync(path.dirname(mcpServerPath), { recursive: true });
    fs.writeFileSync(mcpServerPath, '// test mcp server\n');
    fs.writeFileSync(
      path.join(process.env.EJ_TEST_HOME!, '.codex', 'auth.json'),
      '{"auth_mode":"chatgpt"}\n',
    );
    fs.writeFileSync(
      path.join(process.env.EJ_TEST_HOME!, '.codex', 'config.toml'),
      `model = "gpt-5.4"

[mcp_servers.ejclaw]
command = "node"
args = ["old-ipc.js"]

[mcp_servers.ejclaw.env]
EJCLAW_IPC_DIR = "/old/ipc"

[mcp_servers.other]
command = "node"
args = ["other.js"]
`,
    );

    const sessionDir = path.join(tempRoot, 'readonly-reviewer-session');
    prepareReadonlySessionEnvironment({
      sessionDir,
      chatJid: 'dc:test',
      isMain: false,
      groupFolder: 'codex-test-group',
      agentType: 'codex',
      memoryBriefing: 'memory briefing',
      role: 'reviewer',
    });

    const claudeMd = fs.readFileSync(
      path.join(sessionDir, 'CLAUDE.md'),
      'utf-8',
    );
    expect(
      fs.readFileSync(path.join(sessionDir, '.codex', 'AGENTS.md'), 'utf-8'),
    ).toBe(claudeMd);
    expect(
      fs.readFileSync(path.join(sessionDir, '.codex', 'auth.json'), 'utf-8'),
    ).toContain('"auth_mode":"chatgpt"');
    expect(
      fs.readFileSync(path.join(sessionDir, '.claude.json'), 'utf-8'),
    ).toBe('{}\n');
    const toml = fs.readFileSync(
      path.join(sessionDir, '.codex', 'config.toml'),
      'utf-8',
    );
    expect(toml).toContain('model = "gpt-5.4"');
    expect(toml).toContain('[mcp_servers.other]');
    expect(toml).toContain('[mcp_servers.ejclaw]');
    expect(toml).toContain('EJCLAW_IPC_DIR = "/workspace/ipc"');
    expect(toml).toContain('EJCLAW_GROUP_FOLDER = "codex-test-group"');
    expect(toml).toContain('EJCLAW_WORK_DIR = "/workspace/project"');
    expect(toml).not.toContain('old-ipc.js');
    expect(toml).not.toContain('"/old/ipc"');
    expect(toml.match(/\[mcp_servers\.ejclaw\]/g)).toHaveLength(1);
    expect(toml.match(/\[mcp_servers\.ejclaw\.env\]/g)).toHaveLength(1);
  });
});
