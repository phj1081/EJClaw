/**
 * Resolves the path to the Claude Code native CLI binary bundled with
 * `@anthropic-ai/claude-agent-sdk`.
 *
 * SDK 0.2.113+ ships a per-platform native binary via optional dependencies.
 * Its internal auto-detection (W7() in sdk.mjs) tries the linux-x64-musl
 * package BEFORE linux-x64, so on glibc hosts where bun has installed the musl
 * package as an empty shell (no executable binary) the SDK throws:
 *
 *   "Claude Code native binary not found at .../claude-agent-sdk-linux-x64-musl/claude"
 *
 * By resolving the bundled binary path explicitly we:
 *   - Skip the SDK's unreliable musl/glibc auto-detection.
 *   - Keep EJClaw self-contained (no dependency on a host `claude` install).
 *
 * Override: set `EJCLAW_CLAUDE_CLI_PATH` to a custom absolute binary path.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';

const ENV_OVERRIDE = 'EJCLAW_CLAUDE_CLI_PATH';
const GLM_CODE_ENV_OVERRIDE = 'EJCLAW_GLM_CODE_CLI_PATH';

export type ClaudeCompatibleAgentType = 'claude-code' | 'glm-code';

interface PlatformCandidate {
  pkg: string;
  file: string;
}

function platformCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformCandidate[] {
  if (platform === 'linux') {
    // glibc-first: the SDK gets this wrong (musl-first) — we correct it here.
    return [
      { pkg: `@anthropic-ai/claude-agent-sdk-linux-${arch}`, file: 'claude' },
      {
        pkg: `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
        file: 'claude',
      },
    ];
  }
  if (platform === 'darwin') {
    return [
      {
        pkg: `@anthropic-ai/claude-agent-sdk-darwin-${arch}`,
        file: 'claude',
      },
    ];
  }
  if (platform === 'win32') {
    return [
      {
        pkg: `@anthropic-ai/claude-agent-sdk-win32-${arch}`,
        file: 'claude.exe',
      },
    ];
  }
  return [];
}

/**
 * Returns an absolute path to the bundled Claude Code CLI binary.
 *
 * Resolution order:
 *   1. `EJCLAW_CLAUDE_CLI_PATH` env var (if set and file exists).
 *   2. Platform-appropriate bundled binary under
 *      `runners/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk-*`.
 *
 * Throws if no binary can be found — callers must not fall back silently.
 */
export function resolveBundledClaudeCodeExecutable(options?: {
  /** Override platform (tests only). */
  platform?: NodeJS.Platform;
  /** Override arch (tests only). */
  arch?: string;
  /** Override env source (tests only). */
  env?: NodeJS.ProcessEnv;
  /** Override fs.existsSync (tests only). */
  existsSync?: (p: string) => boolean;
  /** Override how candidate dirs are resolved (tests only). */
  resolvePackageDir?: (pkg: string) => string | null;
}): string {
  const env = options?.env ?? process.env;
  const existsSync = options?.existsSync ?? fs.existsSync;
  const platform = options?.platform ?? process.platform;
  const arch = options?.arch ?? process.arch;

  const override = env[ENV_OVERRIDE];
  if (override && override.trim().length > 0) {
    const resolved = path.resolve(override);
    if (!existsSync(resolved)) {
      throw new Error(
        `${ENV_OVERRIDE} is set to "${override}" but no file exists at that path.`,
      );
    }
    return resolved;
  }

  const resolvePackageDir =
    options?.resolvePackageDir ?? defaultResolvePackageDir;

  const candidates = platformCandidates(platform, arch);
  const tried: string[] = [];
  for (const { pkg, file } of candidates) {
    const dir = resolvePackageDir(pkg);
    if (!dir) {
      tried.push(`${pkg} (package not resolvable)`);
      continue;
    }
    const candidatePath = path.join(dir, file);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
    tried.push(candidatePath);
  }

  throw new Error(
    `Unable to locate a bundled Claude Code CLI binary for platform=${platform} arch=${arch}. ` +
      `Tried: ${tried.join(', ') || '(no candidates for this platform)'}. ` +
      `Set ${ENV_OVERRIDE} to an absolute path to the CLI binary if you have a custom install.`,
  );
}

export function resolveClaudeCompatibleExecutable(options?: {
  agentType?: ClaudeCompatibleAgentType;
  /** Override platform (tests only). */
  platform?: NodeJS.Platform;
  /** Override arch (tests only). */
  arch?: string;
  /** Override env source (tests only). */
  env?: NodeJS.ProcessEnv;
  /** Override fs.existsSync (tests only). */
  existsSync?: (p: string) => boolean;
  /** Override how candidate dirs are resolved (tests only). */
  resolvePackageDir?: (pkg: string) => string | null;
  /** Override command lookup (tests only). */
  resolveCommand?: (command: string) => string | null;
  /** Override known glm-code paths (tests only). */
  knownGlmCodePaths?: string[];
}): string {
  if (options?.agentType === 'glm-code') {
    return resolveGlmCodeExecutable(options);
  }
  return resolveBundledClaudeCodeExecutable(options);
}

function resolveGlmCodeExecutable(options?: {
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
  resolveCommand?: (command: string) => string | null;
  knownGlmCodePaths?: string[];
}): string {
  const env = options?.env ?? process.env;
  const existsSync = options?.existsSync ?? fs.existsSync;
  const resolveCommand = options?.resolveCommand ?? defaultResolveCommand;
  const knownPaths = options?.knownGlmCodePaths ?? defaultGlmCodePaths();

  const override = env[GLM_CODE_ENV_OVERRIDE];
  if (override && override.trim().length > 0) {
    const resolved = path.resolve(override);
    if (!existsSync(resolved)) {
      throw new Error(
        `${GLM_CODE_ENV_OVERRIDE} is set to "${override}" but no file exists at that path.`,
      );
    }
    return resolved;
  }

  const fromPath = resolveCommand('glm-code');
  if (fromPath && existsSync(fromPath)) return fromPath;

  for (const candidate of knownPaths) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Unable to locate a glm-code CLI launcher. Tried PATH command glm-code and: ${knownPaths.join(', ') || '(no known paths)'}. ` +
      `Set ${GLM_CODE_ENV_OVERRIDE} to an absolute path to the glm-code launcher.`,
  );
}

function defaultResolveCommand(command: string): string | null {
  try {
    return execFileSync('bash', ['-lc', `command -v ${command}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function defaultGlmCodePaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin', 'glm-code'),
    path.join(home, '.npm-global', 'bin', 'glm-code'),
    '/usr/local/bin/glm-code',
    '/opt/homebrew/bin/glm-code',
  ];
}

/**
 * Default package directory resolver. Uses `require.resolve` against this
 * module's location so it works regardless of whether agent-runner is invoked
 * from its own node_modules layout or via a parent workspace.
 *
 * Important: the SDK's optional native-binary packages may not expose a bare
 * package entrypoint, so `require.resolve(pkg)` can fail even when the package
 * and binary are installed. Resolve `package.json` first, then fall back to the
 * bare package only for package layouts that do expose an entrypoint.
 */
function defaultResolvePackageDir(pkg: string): string | null {
  const req = createRequire(import.meta.url);
  try {
    const pkgJson = req.resolve(`${pkg}/package.json`);
    return path.dirname(pkgJson);
  } catch {
    // Fall through to legacy/bare-entrypoint resolution below.
  }

  try {
    const entrypoint = req.resolve(pkg);
    return path.dirname(entrypoint);
  } catch {
    return null;
  }
}

export const __test__ = {
  platformCandidates,
  defaultResolvePackageDir,
  defaultGlmCodePaths,
  ENV_OVERRIDE,
  GLM_CODE_ENV_OVERRIDE,
};
