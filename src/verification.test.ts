import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildVerificationCommand,
  computeVerificationSnapshot,
  isVerificationProfile,
  runVerificationRequest,
} from './verification.js';

describe('verification helpers', () => {
  it('recognizes only fixed verification profiles', () => {
    expect(isVerificationProfile('test')).toBe(true);
    expect(isVerificationProfile('typecheck')).toBe(true);
    expect(isVerificationProfile('build')).toBe(true);
    expect(isVerificationProfile('lint')).toBe(false);
  });

  it('builds deterministic commands for each profile', () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-'),
    );
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({}));

    expect(buildVerificationCommand('test', repoDir)).toMatchObject({
      file: 'npm',
      args: ['test'],
      requiredScript: 'test',
    });
    expect(buildVerificationCommand('typecheck', repoDir)).toMatchObject({
      file: 'npm',
      args: ['run', 'typecheck'],
      requiredScript: 'typecheck',
    });
    expect(buildVerificationCommand('build', repoDir)).toMatchObject({
      file: 'npm',
      args: ['run', 'build'],
      requiredScript: 'build',
    });
  });

  it('selects the workspace package manager for verification commands', () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-pnpm-'),
    );
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@10.11.0' }),
    );

    expect(buildVerificationCommand('typecheck', repoDir)).toMatchObject({
      file: 'corepack',
      args: ['pnpm', 'run', 'typecheck'],
      commandText: 'corepack pnpm run typecheck',
      requiredScript: 'typecheck',
    });
  });

  it('computes a stable snapshot over the readable workspace inputs', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-snapshot-'));
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'src', 'index.ts'),
      'export const x = 1;\n',
    );
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=1\n');

    const first = computeVerificationSnapshot(repoDir).snapshotId;
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=2\n');
    const second = computeVerificationSnapshot(repoDir).snapshotId;
    fs.writeFileSync(
      path.join(repoDir, 'src', 'index.ts'),
      'export const x = 2;\n',
    );
    const third = computeVerificationSnapshot(repoDir).snapshotId;

    expect(second).toBe(first);
    expect(third).not.toBe(first);
  });

  it('fails verification when node_modules contains only cache noise', async () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-noise-'),
    );
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.vite'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
          build: 'tsc',
        },
      }),
    );

    const result = await runVerificationRequest(
      {
        requestId: 'req-noise',
        profile: 'typecheck',
      },
      { repoDir },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('installed node_modules tree');
  });
});
