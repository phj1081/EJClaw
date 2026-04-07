import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildDockerRunArgs,
  buildVerificationCommand,
  computeVerificationSnapshot,
  isVerificationProfile,
  runVerificationRequest,
} from './verification.js';
import {
  ensureWorkspaceDependenciesInstalled,
  hasInstalledNodeModules,
} from './workspace-package-manager.js';

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

  it('ignores runtime state directories and local backup folders', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-snapshot-'));
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'cache'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, '.ejclaw-reviewer-runtime'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repoDir, 'store.local-backup-20260408_024500'), {
      recursive: true,
    });

    fs.writeFileSync(
      path.join(repoDir, 'src', 'index.ts'),
      'export const x = 1;\n',
    );
    fs.writeFileSync(path.join(repoDir, 'data', 'state.json'), '{"x":1}\n');
    fs.writeFileSync(path.join(repoDir, 'logs', 'service.log'), 'line-1\n');
    fs.writeFileSync(path.join(repoDir, 'cache', 'tmp.txt'), 'cache-a\n');
    fs.writeFileSync(
      path.join(repoDir, '.ejclaw-reviewer-runtime', 'runtime.json'),
      '{"ok":true}\n',
    );
    fs.writeFileSync(
      path.join(repoDir, 'store.local-backup-20260408_024500', 'db.sqlite'),
      'backup-a\n',
    );

    const first = computeVerificationSnapshot(repoDir).snapshotId;

    fs.writeFileSync(path.join(repoDir, 'data', 'state.json'), '{"x":2}\n');
    fs.writeFileSync(path.join(repoDir, 'logs', 'service.log'), 'line-2\n');
    fs.writeFileSync(path.join(repoDir, 'cache', 'tmp.txt'), 'cache-b\n');
    fs.writeFileSync(
      path.join(repoDir, '.ejclaw-reviewer-runtime', 'runtime.json'),
      '{"ok":false}\n',
    );
    fs.writeFileSync(
      path.join(repoDir, 'store.local-backup-20260408_024500', 'db.sqlite'),
      'backup-b\n',
    );

    const second = computeVerificationSnapshot(repoDir).snapshotId;

    expect(second).toBe(first);
  });

  it('still includes nested source directories named like excluded roots', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-snapshot-'));
    fs.mkdirSync(path.join(repoDir, 'src', 'fixtures', 'data'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoDir, 'src', 'fixtures', 'data', 'sample.json'),
      '{"v":1}\n',
    );

    const first = computeVerificationSnapshot(repoDir).snapshotId;

    fs.writeFileSync(
      path.join(repoDir, 'src', 'fixtures', 'data', 'sample.json'),
      '{"v":2}\n',
    );

    const second = computeVerificationSnapshot(repoDir).snapshotId;

    expect(second).not.toBe(first);
  });

  it('backfills legacy node_modules state before verification', async () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-legacy-'),
    );
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.bin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'verification-legacy',
        packageManager: 'bun@1.3.11',
        scripts: {
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
          build: 'tsc',
        },
      }),
    );
    fs.writeFileSync(path.join(repoDir, 'bun.lock'), '');
    fs.writeFileSync(path.join(repoDir, 'node_modules', '.bin', 'tsc'), '');

    expect(hasInstalledNodeModules(repoDir)).toBe(false);

    const result = await runVerificationRequest(
      {
        requestId: 'req-legacy-node-modules',
        profile: 'typecheck',
        expectedSnapshotId: 'fs:mismatch',
      },
      { repoDir },
    );

    expect(hasInstalledNodeModules(repoDir)).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Snapshot mismatch before verification');
  });

  it('runs verification commands via docker entrypoint override', () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-docker-'),
    );
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.bin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'verification-docker',
        packageManager: 'bun@1.3.11',
        scripts: {
          typecheck: 'tsc --noEmit',
        },
      }),
    );
    fs.writeFileSync(path.join(repoDir, 'bun.lock'), '');
    fs.writeFileSync(path.join(repoDir, 'node_modules', '.bin', 'tsc'), '');
    ensureWorkspaceDependenciesInstalled(repoDir);

    const command = buildVerificationCommand('typecheck', repoDir);
    const args = buildDockerRunArgs('/tmp/verify-workspace', repoDir, command);
    const imageIndex = args.findIndex((value) => value === 'ejclaw-reviewer:latest');

    expect(args).toContain('--entrypoint');
    expect(args[args.indexOf('--entrypoint') + 1]).toBe(command.file);
    expect(imageIndex).toBeGreaterThan(args.indexOf('--entrypoint'));
    expect(args.slice(imageIndex + 1)).toEqual(command.args);
    expect(args).toContain(
      '/workspace/project/node_modules/.vite-temp:uid=1000,gid=1000,mode=1777',
    );
  });
});
