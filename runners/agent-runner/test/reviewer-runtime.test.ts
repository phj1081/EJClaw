import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildReviewerGitGuardEnv,
  isReviewerMutatingShellCommand,
  isReviewerRuntime,
} from '../src/reviewer-runtime.js';

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
  return cwd;
}

describe('claude reviewer runtime guard', () => {
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

  it('flags mutating shell commands', () => {
    expect(isReviewerMutatingShellCommand('git commit -m "x"')).toBe(false);
    expect(isReviewerMutatingShellCommand('git -c color.ui=false commit -m "x"')).toBe(
      false,
    );
    expect(isReviewerMutatingShellCommand('sed -i s/a/b/ file.ts')).toBe(
      true,
    );
    expect(isReviewerMutatingShellCommand('git status')).toBe(false);
    expect(isReviewerMutatingShellCommand('npm test')).toBe(false);
  });

  it('prepends a git wrapper to PATH for reviewer runtimes', () => {
    const env = buildReviewerGitGuardEnv({ PATH: process.env.PATH }, true);
    expect(env.PATH).toContain('ejclaw-reviewer-git-');
    expect(env.EJCLAW_REAL_GIT).toBeTruthy();
  });

  it('prefers an executable HOME-scoped wrapper dir before tmp', () => {
    const homeDir = fs.mkdtempSync(
      path.join(process.cwd(), '.ejclaw-reviewer-home-'),
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
});
