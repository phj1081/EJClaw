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
import {
  ensureWorkspaceDependenciesInstalled,
  hasInstalledNodeModules,
} from './workspace-package-manager.js';

describe('verification helpers', () => {
  it('recognizes only fixed verification profiles', () => {
    expect(isVerificationProfile('test')).toBe(true);
    expect(isVerificationProfile('typecheck')).toBe(true);
    expect(isVerificationProfile('build')).toBe(true);
    expect(isVerificationProfile('lint')).toBe(true);
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
    expect(buildVerificationCommand('lint', repoDir)).toMatchObject({
      file: 'npm',
      args: ['run', 'lint'],
      requiredScript: 'lint',
    });
  });

  it('prefers lint:ci and lint:check before plain lint', () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-lint-'),
    );
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        scripts: {
          lint: 'eslint .',
          'lint:check': 'eslint --max-warnings 0 .',
          'lint:ci': 'eslint --format compact .',
        },
      }),
    );

    expect(buildVerificationCommand('lint', repoDir)).toMatchObject({
      file: 'npm',
      args: ['run', 'lint:ci'],
      requiredScript: 'lint:ci',
    });

    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        scripts: {
          lint: 'eslint .',
          'lint:check': 'eslint --max-warnings 0 .',
        },
      }),
    );

    expect(buildVerificationCommand('lint', repoDir)).toMatchObject({
      file: 'npm',
      args: ['run', 'lint:check'],
      requiredScript: 'lint:check',
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

  it('verifies nested pnpm workspaces under a bun parent without tripping corepack project specs', async () => {
    const parentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-corepack-parent-'),
    );
    fs.writeFileSync(
      path.join(parentDir, 'package.json'),
      JSON.stringify({ packageManager: 'bun@1.3.11' }),
    );

    const repoDir = path.join(parentDir, 'owner');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'nested-pnpm-workspace',
        scripts: {
          typecheck:
            'node -e "process.stdout.write(process.env.COREPACK_ENABLE_PROJECT_SPEC || \'missing\')"',
        },
      }),
    );
    fs.writeFileSync(
      path.join(repoDir, 'pnpm-lock.yaml'),
      [
        "lockfileVersion: '6.0'",
        'settings:',
        '  autoInstallPeers: true',
        '  excludeLinksFromLockfile: false',
        'importers:',
        '  .: {}',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.bin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoDir, 'node_modules', '.bin', 'placeholder'),
      '',
    );

    expect(hasInstalledNodeModules(repoDir)).toBe(false);

    const expectedSnapshotId = computeVerificationSnapshot(repoDir).snapshotId;
    const result = await runVerificationRequest(
      {
        requestId: 'req-corepack-parent-pnpm',
        profile: 'typecheck',
        expectedSnapshotId,
      },
      { repoDir },
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe('corepack pnpm run typecheck');
    expect(result.stdout).toContain('0');
    expect(result.snapshotId).toBe(expectedSnapshotId);
  });

  it('computes a stable snapshot over the readable workspace inputs', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-snapshot-'));
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'src', 'index.ts'),
      'export const x = 1;\n',
    );
    fs.mkdirSync(path.join(repoDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=1\n');
    fs.writeFileSync(
      path.join(repoDir, 'dist', 'index.js'),
      'export const x = 1;\n',
    );

    const first = computeVerificationSnapshot(repoDir).snapshotId;
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=2\n');
    fs.writeFileSync(
      path.join(repoDir, 'dist', 'index.js'),
      'export const x = 2;\n',
    );
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

  it('runs typecheck directly on the host for non-build profiles', async () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-direct-'),
    );
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.bin'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'verification-direct',
        packageManager: 'bun@1.3.11',
        scripts: {
          typecheck:
            "node -e \"process.stdout.write('typecheck:' + (process.env.CI || 'missing'))\"",
        },
      }),
    );
    fs.writeFileSync(path.join(repoDir, 'bun.lock'), '');
    fs.writeFileSync(
      path.join(repoDir, 'node_modules', '.bin', 'placeholder'),
      '',
    );
    fs.writeFileSync(
      path.join(repoDir, 'src', 'index.ts'),
      'export const value = 1;\n',
    );
    ensureWorkspaceDependenciesInstalled(repoDir);

    const expectedSnapshotId = computeVerificationSnapshot(repoDir).snapshotId;
    const result = await runVerificationRequest(
      {
        requestId: 'req-direct-typecheck',
        profile: 'typecheck',
        expectedSnapshotId,
      },
      { repoDir },
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('typecheck:1');
    expect(result.runtimeVersion).toMatch(/^host:bun@/);
    expect(result.snapshotId).toBe(expectedSnapshotId);
  });

  it('runs lint verification using the preferred lint script', async () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-direct-lint-'),
    );
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.bin'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'verification-direct-lint',
        packageManager: 'bun@1.3.11',
        scripts: {
          'lint:check':
            "node -e \"process.stdout.write('lint-check:' + (process.env.CI || 'missing'))\"",
        },
      }),
    );
    fs.writeFileSync(path.join(repoDir, 'bun.lock'), '');
    fs.writeFileSync(
      path.join(repoDir, 'node_modules', '.bin', 'placeholder'),
      '',
    );
    fs.writeFileSync(
      path.join(repoDir, 'src', 'index.ts'),
      'export const value = 1;\n',
    );
    ensureWorkspaceDependenciesInstalled(repoDir);

    const expectedSnapshotId = computeVerificationSnapshot(repoDir).snapshotId;
    const result = await runVerificationRequest(
      {
        requestId: 'req-direct-lint',
        profile: 'lint',
        expectedSnapshotId,
      },
      { repoDir },
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.command).toContain('lint:check');
    expect(result.stdout).toContain('lint-check:1');
    expect(result.snapshotId).toBe(expectedSnapshotId);
  });

  it('does not leak host secrets into direct verification commands', async () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-direct-secret-'),
    );
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.bin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'verification-direct-secret',
        packageManager: 'bun@1.3.11',
        scripts: {
          typecheck:
            'node -e "process.stdout.write(process.env.EJCLAW_VERIFICATION_SECRET || \'missing\')"',
        },
      }),
    );
    fs.writeFileSync(path.join(repoDir, 'bun.lock'), '');
    fs.writeFileSync(
      path.join(repoDir, 'node_modules', '.bin', 'placeholder'),
      '',
    );
    ensureWorkspaceDependenciesInstalled(repoDir);

    const previousSecret = process.env.EJCLAW_VERIFICATION_SECRET;
    process.env.EJCLAW_VERIFICATION_SECRET = 'top-secret';

    try {
      const expectedSnapshotId =
        computeVerificationSnapshot(repoDir).snapshotId;
      const result = await runVerificationRequest(
        {
          requestId: 'req-direct-typecheck-secret',
          profile: 'typecheck',
          expectedSnapshotId,
        },
        { repoDir },
      );

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('missing');
      expect(result.stdout).not.toContain('top-secret');
    } finally {
      if (previousSecret == null) {
        delete process.env.EJCLAW_VERIFICATION_SECRET;
      } else {
        process.env.EJCLAW_VERIFICATION_SECRET = previousSecret;
      }
    }
  });

  it('fails direct verification if the command mutates the workspace', async () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-direct-mutate-'),
    );
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.bin'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'verification-direct-mutate',
        packageManager: 'bun@1.3.11',
        scripts: {
          test: "node -e \"require('node:fs').writeFileSync('src/generated.txt', 'x\\\\n')\"",
        },
      }),
    );
    fs.writeFileSync(path.join(repoDir, 'bun.lock'), '');
    fs.writeFileSync(
      path.join(repoDir, 'node_modules', '.bin', 'placeholder'),
      '',
    );
    fs.writeFileSync(
      path.join(repoDir, 'src', 'index.ts'),
      'export const value = 1;\n',
    );
    ensureWorkspaceDependenciesInstalled(repoDir);

    const expectedSnapshotId = computeVerificationSnapshot(repoDir).snapshotId;
    const result = await runVerificationRequest(
      {
        requestId: 'req-direct-test-mutate',
        profile: 'test',
        expectedSnapshotId,
      },
      { repoDir },
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('Workspace changed during verification');
    expect(result.snapshotId).not.toBe(expectedSnapshotId);
    expect(fs.existsSync(path.join(repoDir, 'src', 'generated.txt'))).toBe(
      true,
    );
  });

  it('allows build verification to write excluded output directories', async () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-build-direct-'),
    );
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.bin'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'verification-build-direct',
        packageManager: 'bun@1.3.11',
        scripts: {
          build:
            "node -e \"require('node:fs').mkdirSync('dist', { recursive: true }); require('node:fs').writeFileSync('dist/output.js', 'ok\\\\n')\"",
        },
      }),
    );
    fs.writeFileSync(path.join(repoDir, 'bun.lock'), '');
    fs.writeFileSync(
      path.join(repoDir, 'node_modules', '.bin', 'placeholder'),
      '',
    );
    fs.writeFileSync(
      path.join(repoDir, 'src', 'index.ts'),
      'export const value = 1;\n',
    );
    ensureWorkspaceDependenciesInstalled(repoDir);

    const expectedSnapshotId = computeVerificationSnapshot(repoDir).snapshotId;
    const result = await runVerificationRequest(
      {
        requestId: 'req-direct-build',
        profile: 'build',
        expectedSnapshotId,
      },
      { repoDir },
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.runtimeVersion).toMatch(/^host:bun@/);
    expect(result.snapshotId).toBe(expectedSnapshotId);
    expect(
      fs.readFileSync(path.join(repoDir, 'dist', 'output.js'), 'utf-8'),
    ).toBe('ok\n');
  });
});
