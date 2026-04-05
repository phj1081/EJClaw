import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT, TEST_DATA_DIR, TEST_GROUPS_DIR, mockDetectAuthMode } =
  vi.hoisted(() => {
    const testRoot = '/tmp/ejclaw-container-runner-test';
    return {
      TEST_ROOT: testRoot,
      TEST_DATA_DIR: `${testRoot}/data`,
      TEST_GROUPS_DIR: `${testRoot}/groups`,
      mockDetectAuthMode: vi.fn<() => 'oauth' | 'api-key'>(),
    };
  });

vi.mock('./config.js', () => ({
  AGENT_MAX_OUTPUT_SIZE: 1024 * 1024,
  AGENT_TIMEOUT: 60_000,
  DATA_DIR: TEST_DATA_DIR,
  GROUPS_DIR: TEST_GROUPS_DIR,
  IDLE_TIMEOUT: 1_000,
  REVIEWER_CONTAINER_IMAGE: 'ejclaw-reviewer:latest',
  TIMEZONE: 'Asia/Seoul',
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  ensureContainerRuntimeRunning: vi.fn(),
  hostGatewayArgs: () => ['--add-host=host.docker.internal:host-gateway'],
  readonlyMountArgs: (hostPath: string, containerPath: string) => [
    '-v',
    `${hostPath}:${containerPath}:ro`,
  ],
  writableMountArgs: (hostPath: string, containerPath: string) => [
    '-v',
    `${hostPath}:${containerPath}`,
  ],
  tmpfsMountArgs: (containerPath: string) => ['--tmpfs', containerPath],
}));

vi.mock('./agent-runner-environment.js', () => ({
  ensureClaudeGlobalSettingsFile: vi.fn(),
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: mockDetectAuthMode,
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    path.join(TEST_GROUPS_DIR, folder),
  resolveGroupIpcPath: (folder: string) =>
    path.join(TEST_DATA_DIR, 'ipc', folder),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  appendExecEnvArgs,
  buildCreateArgs,
  buildReviewerMounts,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'brain',
    trigger: '@Codex',
    added_at: new Date().toISOString(),
    agentType: 'codex',
  };
}

function initGitRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init'], {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('git', ['config', 'user.name', 'EJClaw Test'], {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('container-runner path compatibility', () => {
  const previousCodeXHome = process.env.CODEX_HOME;
  const previousOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
    process.env.CODEX_HOME = path.join(TEST_ROOT, 'codex-home');
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
    mockDetectAuthMode.mockReset();
    mockDetectAuthMode.mockReturnValue('oauth');
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    if (previousCodeXHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodeXHome;
    }
    if (previousOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = previousOauthToken;
    }
  });

  it('mounts the owner workspace at both canonical and host absolute paths and shadows both .env paths', () => {
    const group = makeGroup();
    const ownerWorkspaceDir = path.join(TEST_ROOT, 'workspace', 'owner');
    fs.mkdirSync(ownerWorkspaceDir, { recursive: true });
    fs.writeFileSync(path.join(ownerWorkspaceDir, '.env'), 'SECRET=1\n');
    fs.mkdirSync(path.join(TEST_GROUPS_DIR, group.folder), { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'ipc', group.folder), {
      recursive: true,
    });

    const mounts = buildReviewerMounts(group, ownerWorkspaceDir);

    expect(mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hostPath: ownerWorkspaceDir,
          containerPath: '/workspace/project',
          readonly: true,
        }),
        expect.objectContaining({
          hostPath: ownerWorkspaceDir,
          containerPath: ownerWorkspaceDir,
          readonly: true,
        }),
        expect.objectContaining({
          hostPath: path.join(
            TEST_DATA_DIR,
            'sessions',
            `${group.folder}-reviewer`,
            '.claude.json',
          ),
          containerPath: '/home/node/.claude.json',
          readonly: false,
        }),
        expect.objectContaining({
          hostPath: '/dev/null',
          containerPath: '/workspace/project/.env',
          readonly: true,
        }),
        expect.objectContaining({
          hostPath: '/dev/null',
          containerPath: path.join(ownerWorkspaceDir, '.env'),
          readonly: true,
        }),
      ]),
    );
  });

  it('mounts a local absolute origin target and shadows its .env', () => {
    const group = makeGroup();
    const canonicalRepoDir = path.join(TEST_ROOT, 'canonical');
    const ownerWorkspaceDir = path.join(TEST_ROOT, 'workspace', 'owner');
    initGitRepo(canonicalRepoDir);
    initGitRepo(ownerWorkspaceDir);
    execFileSync('git', ['remote', 'add', 'origin', canonicalRepoDir], {
      cwd: ownerWorkspaceDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    fs.writeFileSync(path.join(canonicalRepoDir, '.env'), 'CANONICAL=1\n');
    fs.mkdirSync(path.join(TEST_GROUPS_DIR, group.folder), { recursive: true });
    fs.mkdirSync(path.join(TEST_DATA_DIR, 'ipc', group.folder), {
      recursive: true,
    });

    const mounts = buildReviewerMounts(group, ownerWorkspaceDir);

    expect(mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hostPath: canonicalRepoDir,
          containerPath: canonicalRepoDir,
          readonly: true,
        }),
        expect.objectContaining({
          hostPath: '/dev/null',
          containerPath: path.join(canonicalRepoDir, '.env'),
          readonly: true,
        }),
      ]),
    );
  });

  it('keeps dynamic workdir and role env on docker exec instead of baking them into container creation', () => {
    const createArgs = buildCreateArgs([], 'ejclaw-reviewer-brain');
    const createText = createArgs.join(' ');

    expect(createText).not.toContain('EJCLAW_WORK_DIR=');
    expect(createText).not.toContain('EJCLAW_PAIRED_ROLE=');
    expect(createText).not.toContain('CLAUDE_CONFIG_DIR=');
    expect(createText).not.toContain('EJCLAW_REVIEWER_RUNTIME=');

    const reviewerExecArgs = ['exec', '-i'];
    appendExecEnvArgs(
      reviewerExecArgs,
      {
        EJCLAW_WORK_DIR: '/home/clone-ej/project',
        EJCLAW_PAIRED_TASK_ID: 'task-1',
        EJCLAW_PAIRED_ROLE: 'reviewer',
        EJCLAW_REVIEWER_RUNTIME: '1',
        CLAUDE_CONFIG_DIR: '/host/reviewer-session',
        CLAUDE_MODEL: 'claude-sonnet',
        CODEX_MODEL: 'gpt-5-codex',
      },
      false,
    );

    const reviewerExecText = reviewerExecArgs.join(' ');
    expect(reviewerExecText).toContain(
      'EJCLAW_WORK_DIR=/home/clone-ej/project',
    );
    expect(reviewerExecText).toContain('EJCLAW_PAIRED_TASK_ID=task-1');
    expect(reviewerExecText).toContain('EJCLAW_PAIRED_ROLE=reviewer');
    expect(reviewerExecText).toContain('EJCLAW_REVIEWER_RUNTIME=1');
    expect(reviewerExecText).toContain('CLAUDE_CONFIG_DIR=/home/node/.claude');
    expect(reviewerExecText).toContain('CLAUDE_MODEL=claude-sonnet');
    expect(reviewerExecText).not.toContain('CODEX_MODEL=gpt-5-codex');

    const codexExecArgs = ['exec', '-i'];
    appendExecEnvArgs(
      codexExecArgs,
      {
        CODEX_MODEL: 'gpt-5-codex',
        CLAUDE_MODEL: 'claude-sonnet',
      },
      true,
    );

    const codexExecText = codexExecArgs.join(' ');
    expect(codexExecText).toContain('CODEX_MODEL=gpt-5-codex');
    expect(codexExecText).not.toContain('CLAUDE_MODEL=claude-sonnet');
  });
});
