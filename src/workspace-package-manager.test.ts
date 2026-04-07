import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
}));

import {
  buildWorkspaceScriptCommand,
  detectWorkspacePackageManager,
  ensureWorkspaceDependenciesInstalled,
  hasInstalledNodeModules,
  resolveWorkspaceInstallCommand,
} from './workspace-package-manager.js';

describe('workspace package manager helpers', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-pkgmgr-'));
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('detects package managers from packageManager field and lockfiles', () => {
    const pnpmRepo = path.join(tempRoot, 'pnpm');
    fs.mkdirSync(pnpmRepo, { recursive: true });
    fs.writeFileSync(
      path.join(pnpmRepo, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@10.11.0' }),
    );

    const bunRepo = path.join(tempRoot, 'bun');
    fs.mkdirSync(bunRepo, { recursive: true });
    fs.writeFileSync(path.join(bunRepo, 'package.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(bunRepo, 'bun.lock'), '');

    const yarnRepo = path.join(tempRoot, 'yarn');
    fs.mkdirSync(yarnRepo, { recursive: true });
    fs.writeFileSync(path.join(yarnRepo, 'package.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(yarnRepo, 'yarn.lock'), '');

    const mixedRepo = path.join(tempRoot, 'mixed');
    fs.mkdirSync(mixedRepo, { recursive: true });
    fs.writeFileSync(
      path.join(mixedRepo, 'package.json'),
      JSON.stringify({ packageManager: 'bun@1.3.11' }),
    );
    fs.writeFileSync(path.join(mixedRepo, 'bun.lock'), '');
    fs.writeFileSync(
      path.join(mixedRepo, 'pnpm-lock.yaml'),
      'lockfileVersion: 9.0\n',
    );

    expect(detectWorkspacePackageManager(pnpmRepo)).toBe('pnpm');
    expect(detectWorkspacePackageManager(bunRepo)).toBe('bun');
    expect(detectWorkspacePackageManager(yarnRepo)).toBe('yarn');
    expect(detectWorkspacePackageManager(mixedRepo)).toBe('bun');
  });

  it('fails fast when multiple lockfiles exist without a packageManager field', () => {
    const repoDir = path.join(tempRoot, 'ambiguous');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(repoDir, 'bun.lock'), '');
    fs.writeFileSync(path.join(repoDir, 'package-lock.json'), '{}\n');

    expect(() => detectWorkspacePackageManager(repoDir)).toThrow(
      /Ambiguous package manager/i,
    );
  });

  it('builds script and install commands for non-npm workspaces', () => {
    const pnpmRepo = path.join(tempRoot, 'pnpm');
    fs.mkdirSync(pnpmRepo, { recursive: true });
    fs.writeFileSync(
      path.join(pnpmRepo, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@10.11.0' }),
    );

    const bunRepo = path.join(tempRoot, 'bun');
    fs.mkdirSync(bunRepo, { recursive: true });
    fs.writeFileSync(path.join(bunRepo, 'package.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(bunRepo, 'bun.lock'), '');

    expect(buildWorkspaceScriptCommand(pnpmRepo, 'typecheck')).toMatchObject({
      file: 'corepack',
      args: ['pnpm', 'run', 'typecheck'],
      commandText: 'corepack pnpm run typecheck',
    });
    expect(resolveWorkspaceInstallCommand(pnpmRepo)).toMatchObject({
      file: 'corepack',
      args: ['pnpm', 'install', '--frozen-lockfile'],
      commandText: 'corepack pnpm install --frozen-lockfile',
    });
    expect(buildWorkspaceScriptCommand(bunRepo, 'build')).toMatchObject({
      file: 'bun',
      args: ['run', 'build'],
      commandText: 'bun run build',
    });
  });

  it('installs dependencies once and tracks install fingerprint', () => {
    const repoDir = path.join(tempRoot, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'repo',
        packageManager: 'pnpm@10.11.0',
        scripts: { typecheck: 'tsc --noEmit' },
      }),
    );
    fs.writeFileSync(
      path.join(repoDir, 'pnpm-lock.yaml'),
      'lockfileVersion: 9.0\n',
    );

    execFileSyncMock.mockImplementation((_file, _args, options) => {
      const cwd = (options as { cwd: string }).cwd;
      fs.mkdirSync(path.join(cwd, 'node_modules', '.bin'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'node_modules', '.bin', 'tsc'), '');
      return '';
    });

    const first = ensureWorkspaceDependenciesInstalled(repoDir);
    expect(first).toMatchObject({
      installed: true,
      packageManager: 'pnpm',
      commandText: 'corepack pnpm install --frozen-lockfile',
    });
    expect(hasInstalledNodeModules(repoDir)).toBe(true);

    execFileSyncMock.mockClear();
    const second = ensureWorkspaceDependenciesInstalled(repoDir);
    expect(second).toMatchObject({
      installed: false,
      packageManager: 'pnpm',
    });
    expect(execFileSyncMock).not.toHaveBeenCalled();

    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'repo',
        packageManager: 'pnpm@10.11.0',
        scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' },
      }),
    );

    expect(hasInstalledNodeModules(repoDir)).toBe(false);
  });

  it('rejects no-op installs that only leave the sentinel file behind', () => {
    const repoDir = path.join(tempRoot, 'noop');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'noop',
        packageManager: 'npm@10.0.0',
        scripts: { typecheck: 'tsc --noEmit' },
      }),
    );
    fs.writeFileSync(path.join(repoDir, 'package-lock.json'), '{}\n');

    execFileSyncMock.mockImplementation(() => '');

    expect(() => ensureWorkspaceDependenciesInstalled(repoDir)).toThrow(
      /did not produce a usable node_modules tree/i,
    );
    expect(hasInstalledNodeModules(repoDir)).toBe(false);
  });

  it('backfills install state for a legacy runnable node_modules tree', () => {
    const repoDir = path.join(tempRoot, 'legacy');
    fs.mkdirSync(path.join(repoDir, 'node_modules', '.bin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoDir, 'package.json'),
      JSON.stringify({
        name: 'legacy',
        packageManager: 'bun@1.3.11',
        scripts: { test: 'vitest run' },
      }),
    );
    fs.writeFileSync(path.join(repoDir, 'bun.lock'), '');
    fs.writeFileSync(path.join(repoDir, 'node_modules', '.bin', 'vitest'), '');

    expect(hasInstalledNodeModules(repoDir)).toBe(false);

    const result = ensureWorkspaceDependenciesInstalled(repoDir);

    expect(result).toMatchObject({
      installed: false,
      packageManager: 'bun',
    });
    expect(hasInstalledNodeModules(repoDir)).toBe(true);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
