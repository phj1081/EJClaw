import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

import type { RoomRoleContext } from './room-role-context.js';

export type RunnerAgentType = 'claude-code' | 'codex';
export type ClaudeReadonlySandboxMode = 'strict' | 'best-effort';

export const REVIEWER_RUNTIME_ENV = 'EJCLAW_REVIEWER_RUNTIME';
export const ARBITER_RUNTIME_ENV = 'EJCLAW_ARBITER_RUNTIME';
export const UNSAFE_HOST_PAIRED_MODE_ENV = 'EJCLAW_UNSAFE_HOST_PAIRED_MODE';
export const CLAUDE_REVIEWER_READONLY_ENV = 'EJCLAW_CLAUDE_REVIEWER_READONLY';

export interface ReviewerRuntimeCapabilities {
  agentType: RunnerAgentType;
  supportsShellPreflightHook: boolean;
  supportsReadonlySandboxing: boolean;
  supportsGitWriteGuard: boolean;
  supportsHardMutationBlocking: boolean;
}

const REVIEWER_RUNTIME_CAPABILITIES = {
  'claude-code': {
    agentType: 'claude-code',
    supportsShellPreflightHook: true,
    supportsReadonlySandboxing: true,
    supportsGitWriteGuard: true,
    supportsHardMutationBlocking: true,
  },
  codex: {
    agentType: 'codex',
    supportsShellPreflightHook: false,
    supportsReadonlySandboxing: false,
    supportsGitWriteGuard: true,
    supportsHardMutationBlocking: false,
  },
} satisfies Record<RunnerAgentType, ReviewerRuntimeCapabilities>;

const MUTATING_SHELL_PATTERNS = [
  /\bsed\s+-i\b/i,
  /\bperl\s+-i\b/i,
  /(^|[;&|])\s*(cat|echo|printf)\b[^#\n]*>>?/i,
];

export function getReviewerRuntimeCapabilities(
  agentType: RunnerAgentType,
): ReviewerRuntimeCapabilities {
  return REVIEWER_RUNTIME_CAPABILITIES[agentType];
}

export function isUnsafeHostPairedModeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[UNSAFE_HOST_PAIRED_MODE_ENV] === '1';
}

export function isReviewerRuntimeEnvEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[REVIEWER_RUNTIME_ENV] === '1';
}

export function isArbiterRuntimeEnvEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[ARBITER_RUNTIME_ENV] === '1';
}

export function isClaudeReadonlyReviewerRuntime(
  roomRoleContext?: RoomRoleContext,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isUnsafeHostPairedModeEnabled(env) &&
    env[CLAUDE_REVIEWER_READONLY_ENV] === '1' &&
    roomRoleContext?.role === 'reviewer'
  );
}

export function buildPairedReadonlyRuntimeEnvOverrides(args: {
  role: 'reviewer' | 'arbiter';
  agentType: RunnerAgentType;
  unsafeHostPairedMode: boolean;
}): Record<string, string> {
  const { role, agentType, unsafeHostPairedMode } = args;
  const env: Record<string, string> = {};

  if (unsafeHostPairedMode) {
    env[UNSAFE_HOST_PAIRED_MODE_ENV] = '1';
  }

  if (role === 'arbiter') {
    if (!unsafeHostPairedMode) {
      env[ARBITER_RUNTIME_ENV] = '1';
    }
    return env;
  }

  if (!unsafeHostPairedMode) {
    env[REVIEWER_RUNTIME_ENV] = '1';
    return env;
  }

  if (getReviewerRuntimeCapabilities(agentType).supportsHardMutationBlocking) {
    env[CLAUDE_REVIEWER_READONLY_ENV] = '1';
  }

  return env;
}

let cachedLinuxBubblewrapReadonlyCapability: boolean | undefined;

function commandExistsForRuntime(command: string): boolean {
  try {
    execFileSync('bash', ['-lc', `command -v ${command}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function canUseLinuxBubblewrapReadonlySandbox(): boolean {
  if (cachedLinuxBubblewrapReadonlyCapability != null) {
    return cachedLinuxBubblewrapReadonlyCapability;
  }
  if (os.platform() !== 'linux') {
    cachedLinuxBubblewrapReadonlyCapability = false;
    return false;
  }
  if (!commandExistsForRuntime('bwrap')) {
    cachedLinuxBubblewrapReadonlyCapability = false;
    return false;
  }

  try {
    execFileSync('bwrap', ['--ro-bind', '/', '/', '/bin/true'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    cachedLinuxBubblewrapReadonlyCapability = true;
  } catch {
    cachedLinuxBubblewrapReadonlyCapability = false;
  }

  return cachedLinuxBubblewrapReadonlyCapability;
}

export function getClaudeReadonlySandboxMode(
  platform: NodeJS.Platform = os.platform(),
  linuxCapabilityProbe: () => boolean = canUseLinuxBubblewrapReadonlySandbox,
): ClaudeReadonlySandboxMode {
  if (platform === 'linux') {
    return linuxCapabilityProbe() ? 'strict' : 'best-effort';
  }
  return 'best-effort';
}

export function buildClaudeReadonlySandboxSettings(
  protectedPaths: string[],
  platform: NodeJS.Platform = os.platform(),
  sandboxMode: ClaudeReadonlySandboxMode = getClaudeReadonlySandboxMode(
    platform,
  ),
) {
  const normalizedPaths = [
    ...new Set(
      protectedPaths
        .filter((value): value is string => Boolean(value))
        .map((value) => path.resolve(value)),
    ),
  ];

  return {
    enabled: true,
    failIfUnavailable: sandboxMode === 'strict',
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem:
      normalizedPaths.length > 0 ? { denyWrite: normalizedPaths } : undefined,
  };
}

export function isReviewerMutatingShellCommand(command: string): boolean {
  const normalized = command.trim();
  return MUTATING_SHELL_PATTERNS.some((pattern) => pattern.test(normalized));
}
