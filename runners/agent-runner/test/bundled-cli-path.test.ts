import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveBundledClaudeCodeExecutable } from '../src/bundled-cli-path.js';

describe('resolveBundledClaudeCodeExecutable', () => {
  const origEnv = process.env.EJCLAW_CLAUDE_CLI_PATH;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.EJCLAW_CLAUDE_CLI_PATH;
    } else {
      process.env.EJCLAW_CLAUDE_CLI_PATH = origEnv;
    }
  });

  it('honors EJCLAW_CLAUDE_CLI_PATH when the file exists', () => {
    const fake = '/tmp/fake-claude-binary-path';
    const existsSync = (p: string): boolean => p === fake;
    const result = resolveBundledClaudeCodeExecutable({
      env: { EJCLAW_CLAUDE_CLI_PATH: fake },
      existsSync,
      platform: 'linux',
      arch: 'x64',
      resolvePackageDir: () => null,
    });
    expect(result).toBe(path.resolve(fake));
  });

  it('throws when env override points at a non-existent file', () => {
    const existsSync = () => false;
    expect(() =>
      resolveBundledClaudeCodeExecutable({
        env: { EJCLAW_CLAUDE_CLI_PATH: '/does/not/exist' },
        existsSync,
        platform: 'linux',
        arch: 'x64',
        resolvePackageDir: () => null,
      }),
    ).toThrow(/EJCLAW_CLAUDE_CLI_PATH/);
  });

  it('prefers Linux glibc binary over musl binary', () => {
    const glibcDir = '/fake/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64';
    const muslDir =
      '/fake/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl';
    const existsSync = (p: string): boolean => {
      // Simulate: both dirs resolve, but only glibc has an actual binary.
      return p === path.join(glibcDir, 'claude');
    };
    const result = resolveBundledClaudeCodeExecutable({
      env: {},
      existsSync,
      platform: 'linux',
      arch: 'x64',
      resolvePackageDir: (pkg) =>
        pkg === '@anthropic-ai/claude-agent-sdk-linux-x64'
          ? glibcDir
          : pkg === '@anthropic-ai/claude-agent-sdk-linux-x64-musl'
            ? muslDir
            : null,
    });
    expect(result).toBe(path.join(glibcDir, 'claude'));
  });

  it('falls back to musl binary if glibc package is not present', () => {
    const muslDir =
      '/fake/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl';
    const existsSync = (p: string): boolean =>
      p === path.join(muslDir, 'claude');
    const result = resolveBundledClaudeCodeExecutable({
      env: {},
      existsSync,
      platform: 'linux',
      arch: 'x64',
      resolvePackageDir: (pkg) =>
        pkg === '@anthropic-ai/claude-agent-sdk-linux-x64-musl' ? muslDir : null,
    });
    expect(result).toBe(path.join(muslDir, 'claude'));
  });

  it('resolves Darwin arm64 binary under `cli`', () => {
    const dir = '/fake/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64';
    const existsSync = (p: string): boolean => p === path.join(dir, 'cli');
    const result = resolveBundledClaudeCodeExecutable({
      env: {},
      existsSync,
      platform: 'darwin',
      arch: 'arm64',
      resolvePackageDir: (pkg) =>
        pkg === '@anthropic-ai/claude-agent-sdk-darwin-arm64' ? dir : null,
    });
    expect(result).toBe(path.join(dir, 'cli'));
  });

  it('resolves Windows binary under `cli.exe`', () => {
    const dir = 'C:\\\\fake\\\\node_modules\\\\@anthropic-ai\\\\claude-agent-sdk-win32-x64';
    const binary = path.join(dir, 'cli.exe');
    const existsSync = (p: string): boolean => p === binary;
    const result = resolveBundledClaudeCodeExecutable({
      env: {},
      existsSync,
      platform: 'win32',
      arch: 'x64',
      resolvePackageDir: (pkg) =>
        pkg === '@anthropic-ai/claude-agent-sdk-win32-x64' ? dir : null,
    });
    expect(result).toBe(binary);
  });

  it('throws a descriptive error when no binary is found', () => {
    const existsSync = () => false;
    expect(() =>
      resolveBundledClaudeCodeExecutable({
        env: {},
        existsSync,
        platform: 'linux',
        arch: 'x64',
        resolvePackageDir: () => null,
      }),
    ).toThrow(/Unable to locate a bundled Claude Code CLI binary/);
  });

  it('end-to-end: resolves the actual bundled binary on this host', () => {
    // Real-world smoke test — the file must exist in the installed workspace.
    const result = resolveBundledClaudeCodeExecutable({
      env: {},
    });
    expect(fs.existsSync(result)).toBe(true);
    // On Linux glibc we expect the non-musl binary to win.
    if (process.platform === 'linux') {
      expect(result).not.toMatch(/linux-x64-musl/);
    }
  });
});
