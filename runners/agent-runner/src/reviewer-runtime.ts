import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

import type { RoomRoleContext } from './room-role-context.js';
export {
  assertReadonlyWorkspaceRepoConnectivity,
  buildReviewerGitGuardEnv,
  isReviewerRuntime,
} from 'ejclaw-runners-shared';

export type ClaudeReadonlySandboxMode = 'strict' | 'best-effort';

const MUTATING_SHELL_PATTERNS = [
  /\bsed\s+-i\b/i,
  /\bperl\s+-i\b/i,
  /(^|[;&|])\s*(cat|echo|printf)\b[^#\n]*>>?/i,
];

export function isClaudeReadonlyReviewerRuntime(
  roomRoleContext?: RoomRoleContext,
): boolean {
  return (
    process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE === '1' &&
    process.env.EJCLAW_CLAUDE_REVIEWER_READONLY === '1' &&
    roomRoleContext?.role === 'reviewer'
  );
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
