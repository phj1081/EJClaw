import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildVerificationCommand,
  computeVerificationSnapshot,
  isVerificationProfile,
} from './verification.js';

describe('verification helpers', () => {
  it('recognizes only fixed verification profiles', () => {
    expect(isVerificationProfile('test')).toBe(true);
    expect(isVerificationProfile('typecheck')).toBe(true);
    expect(isVerificationProfile('build')).toBe(true);
    expect(isVerificationProfile('lint')).toBe(false);
  });

  it('builds deterministic commands for each profile', () => {
    expect(buildVerificationCommand('test')).toMatchObject({
      file: 'npm',
      args: ['test'],
      requiredScript: 'test',
    });
    expect(buildVerificationCommand('typecheck')).toMatchObject({
      file: 'npm',
      args: ['run', 'typecheck'],
      requiredScript: 'typecheck',
    });
    expect(buildVerificationCommand('build')).toMatchObject({
      file: 'npm',
      args: ['run', 'build'],
      requiredScript: 'build',
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
});
