import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertReadonlyWorkspaceRepoConnectivity,
  buildReviewerGitGuardEnv,
  isReviewerRuntime,
} from '../src/reviewer-runtime.js';

const ORIGINAL_UNSAFE_HOST_PAIRED_MODE =
  process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE;

afterEach(() => {
  if (ORIGINAL_UNSAFE_HOST_PAIRED_MODE == null) {
    delete process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE;
  } else {
    process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE =
      ORIGINAL_UNSAFE_HOST_PAIRED_MODE;
  }
});

beforeEach(() => {
  delete process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE;
});

function createTempRepo(prefix: string): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('git', ['config', 'user.name', 'EJClaw Test'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fs.writeFileSync(path.join(cwd, 'README.md'), 'seed\n');
  execFileSync('git', ['add', 'README.md'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('git', ['commit', '-m', 'seed'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return cwd;
}

describe('codex reviewer runtime guard', () => {
  it('detects reviewer room metadata', () => {
    expect(
      isReviewerRuntime({
        serviceId: 'codex-review',
        role: 'reviewer',
        ownerServiceId: 'codex-main',
        reviewerServiceId: 'codex-review',
        failoverOwner: false,
      }),
    ).toBe(true);
  });

  it('prepends a git wrapper to PATH for reviewer runtimes', () => {
    const env = buildReviewerGitGuardEnv({ PATH: process.env.PATH }, true);
    expect(env.PATH).toContain('ejclaw-reviewer-git-');
    expect(env.EJCLAW_REAL_GIT).toBeTruthy();
    expect(env.GIT_CONFIG_GLOBAL).toContain('global.gitconfig');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(fs.existsSync(env.GIT_CONFIG_GLOBAL!)).toBe(true);
  });

  it('prefers an executable HOME-scoped wrapper dir before tmp', () => {
    const homeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-reviewer-home-'),
    );
    try {
      const env = buildReviewerGitGuardEnv(
        {
          PATH: process.env.PATH,
          HOME: homeDir,
        },
        true,
      );
      const wrapperDir = env.PATH?.split(path.delimiter)[0] ?? '';
      expect(wrapperDir).toContain(
        path.join(homeDir, '.ejclaw-reviewer-runtime'),
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('allows mutating git commands in temp repos outside the protected workspace', () => {
    const protectedDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-protected-workspace-'),
    );
    const env = buildReviewerGitGuardEnv(
      {
        PATH: process.env.PATH,
        EJCLAW_WORK_DIR: protectedDir,
      },
      true,
    );
    const cwd = createTempRepo('ejclaw-reviewer-temp-repo-');
    fs.writeFileSync(path.join(cwd, 'note.txt'), 'ok\n');

    expect(() =>
      execFileSync('git', ['add', 'note.txt'], {
        cwd,
        env,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).not.toThrow();
  });

  it('blocks mutating git subcommands inside the protected reviewer workspace', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-reviewer-test-'));
    const env = buildReviewerGitGuardEnv(
      {
        PATH: process.env.PATH,
        EJCLAW_WORK_DIR: cwd,
      },
      true,
    );

    try {
      execFileSync('git', ['-c', 'color.ui=false', 'commit', '-m', 'x'], {
        cwd,
        env,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('expected git wrapper to block commit');
    } catch (error) {
      const stderr =
        error instanceof Error && 'stderr' in error
          ? String((error as Error & { stderr?: string | Buffer }).stderr ?? '')
          : '';
      expect(stderr).toContain(
        'EJClaw reviewer runtime blocks mutating git subcommands: commit',
      );
    }
  });

  it('overrides problematic git config paths so read-only git queries still work', () => {
    const cwd = createTempRepo('ejclaw-reviewer-readonly-git-');
    const env = buildReviewerGitGuardEnv(
      {
        PATH: process.env.PATH,
        HOME: cwd,
        EJCLAW_WORK_DIR: cwd,
        GIT_CONFIG_GLOBAL: path.join(cwd, '.gitconfig'),
      },
      true,
    );

    expect(env.GIT_CONFIG_GLOBAL).not.toBe(path.join(cwd, '.gitconfig'));
    expect(() =>
      execFileSync('git', ['log', '--oneline', '-1'], {
        cwd,
        env,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).not.toThrow();
    expect(fs.existsSync(path.join(cwd, '.gitconfig'))).toBe(false);
  });

  it('accepts a mounted local origin path that resolves as a git repo', () => {
    const originDir = createTempRepo('ejclaw-reviewer-origin-');
    const cwd = createTempRepo('ejclaw-reviewer-workspace-');
    execFileSync('git', ['remote', 'add', 'origin', originDir], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const env = buildReviewerGitGuardEnv(
      {
        PATH: process.env.PATH,
        EJCLAW_WORK_DIR: cwd,
      },
      true,
    );

    expect(() =>
      assertReadonlyWorkspaceRepoConnectivity(env, true),
    ).not.toThrow();
  });

  it.each([
    'https://github.com/EyeJoker-Internal/eyejoker-db.git',
    'git@github.com:EyeJoker-Internal/eyejoker-db.git',
  ])(
    'accepts remote origin %s without requiring a mounted local canonical path',
    (originUrl) => {
      const cwd = createTempRepo('ejclaw-reviewer-remote-origin-');
      execFileSync('git', ['remote', 'add', 'origin', originUrl], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const env = buildReviewerGitGuardEnv(
        {
          PATH: process.env.PATH,
          EJCLAW_WORK_DIR: cwd,
        },
        true,
      );

      expect(() =>
        assertReadonlyWorkspaceRepoConnectivity(env, true),
      ).not.toThrow();
    },
  );

  it('fails fast when the local origin path is not mounted as a git repo', () => {
    const cwd = createTempRepo('ejclaw-reviewer-workspace-');
    const missingOriginDir = path.join(
      os.tmpdir(),
      `ejclaw-reviewer-missing-origin-${Date.now()}`,
    );
    execFileSync('git', ['remote', 'add', 'origin', missingOriginDir], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const env = buildReviewerGitGuardEnv(
      {
        PATH: process.env.PATH,
        EJCLAW_WORK_DIR: cwd,
      },
      true,
    );

    expect(() => assertReadonlyWorkspaceRepoConnectivity(env, true)).toThrow(
      `EJClaw readonly runtime cannot access local git origin path: ${missingOriginDir}`,
    );
  });
});
