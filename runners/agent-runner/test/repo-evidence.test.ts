import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildRepoEvidenceCommand,
  formatRepoEvidenceResponse,
  normalizeRepoEvidenceLimit,
  normalizeRepoEvidenceRef,
  runRepoEvidenceRequestDirect,
} from '../src/repo-evidence.js';

describe('repo evidence helpers', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-repo-evidence-'));
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'Test User'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'initial\n');
    execFileSync('git', ['add', 'README.md'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['commit', '-m', 'initial commit'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('normalizes bounded log limits', () => {
    expect(normalizeRepoEvidenceLimit()).toBe(10);
    expect(normalizeRepoEvidenceLimit(0)).toBe(1);
    expect(normalizeRepoEvidenceLimit(3.8)).toBe(3);
    expect(normalizeRepoEvidenceLimit(100)).toBe(30);
  });

  it('rejects refs that can change command behavior or request ranges', () => {
    expect(normalizeRepoEvidenceRef()).toBe('HEAD');
    expect(normalizeRepoEvidenceRef(' HEAD~1 ')).toBe('HEAD~1');
    expect(() => normalizeRepoEvidenceRef('--help')).toThrow(
      'Unsupported git ref',
    );
    expect(() => normalizeRepoEvidenceRef('main..HEAD')).toThrow(
      'Unsupported git ref',
    );
    expect(() => normalizeRepoEvidenceRef('HEAD;rm')).toThrow(
      'Unsupported git ref',
    );
  });

  it('builds fixed git commands without invoking a shell', () => {
    expect(buildRepoEvidenceCommand(repoDir, { action: 'git_status' })).toEqual(
      {
        file: 'git',
        args: ['-C', repoDir, 'status', '--short', '--branch'],
        commandText: `git -C ${repoDir} status --short --branch`,
      },
    );

    expect(
      buildRepoEvidenceCommand(repoDir, {
        action: 'git_recent_log',
        limit: 100,
      }).args,
    ).toContain('-30');

    expect(
      buildRepoEvidenceCommand(repoDir, {
        action: 'git_show_ref',
        ref: 'HEAD',
      }).args,
    ).toEqual([
      '-C',
      repoDir,
      'show',
      '--stat',
      '--oneline',
      '--decorate',
      '--no-ext-diff',
      '--no-renames',
      'HEAD',
    ]);
  });

  it('reads read-only git evidence from the target repository', async () => {
    fs.appendFileSync(path.join(repoDir, 'README.md'), 'dirty\n');

    const status = await runRepoEvidenceRequestDirect(repoDir, {
      action: 'git_status',
    });
    expect(status.ok).toBe(true);
    expect(status.stdout).toContain('README.md');

    const head = await runRepoEvidenceRequestDirect(repoDir, {
      action: 'git_head',
    });
    expect(head.ok).toBe(true);
    expect(head.stdout).toContain('initial commit');

    const log = await runRepoEvidenceRequestDirect(repoDir, {
      action: 'git_recent_log',
      limit: 2,
    });
    expect(log.ok).toBe(true);
    expect(log.stdout).toContain('initial commit');

    const shown = await runRepoEvidenceRequestDirect(repoDir, {
      action: 'git_show_ref',
      ref: 'HEAD',
    });
    expect(shown.ok).toBe(true);
    expect(shown.stdout).toContain('initial commit');
    expect(shown.stdout).toContain('README.md');
  });

  it('formats failures into MCP-friendly evidence', async () => {
    const response = await runRepoEvidenceRequestDirect(repoDir, {
      action: 'git_show_ref',
      ref: '--help',
    });

    expect(response.ok).toBe(false);
    const text = formatRepoEvidenceResponse(response);
    expect(text).toContain('Repo evidence action: git_show_ref');
    expect(text).toContain(`Workdir: ${repoDir}`);
    expect(text).toContain('Exit code: 1');
    expect(text).toContain('[error] Unsupported git ref');
  });
});
