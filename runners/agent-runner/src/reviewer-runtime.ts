import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { RoomRoleContext } from './room-role-context.js';

export type ClaudeReadonlySandboxMode = 'strict' | 'best-effort';

const BLOCKED_GIT_SUBCOMMANDS = new Set([
  'add',
  'am',
  'apply',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'merge',
  'push',
  'rebase',
  'reset',
  'restore',
  'stash',
  'switch',
  'tag',
  'worktree',
]);

const MUTATING_SHELL_PATTERNS = [
  /\bsed\s+-i\b/i,
  /\bperl\s+-i\b/i,
  /(^|[;&|])\s*(cat|echo|printf)\b[^#\n]*>>?/i,
];

export function isReviewerRuntime(
  roomRoleContext?: RoomRoleContext,
): boolean {
  if (process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE === '1') {
    return false;
  }
  return roomRoleContext?.role === 'reviewer';
}

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
  const normalizedPaths = [...new Set(
    protectedPaths
      .filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(value)),
  )];

  return {
    enabled: true,
    failIfUnavailable: sandboxMode === 'strict',
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem:
      normalizedPaths.length > 0
        ? { denyWrite: normalizedPaths }
        : undefined,
  };
}

function resolveGitBinary(baseEnv: NodeJS.ProcessEnv): string {
  return execFileSync('bash', ['-lc', 'command -v git'], {
    encoding: 'utf-8',
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createExecutableWrapperDir(baseEnv: NodeJS.ProcessEnv): string {
  const candidateRoots = [
    baseEnv.EJCLAW_REVIEWER_GIT_WRAPPER_ROOT,
    baseEnv.HOME ? path.join(baseEnv.HOME, '.ejclaw-reviewer-runtime') : null,
    path.join(os.tmpdir(), '.ejclaw-reviewer-runtime'),
  ].filter((value): value is string => Boolean(value));

  const probeContents = '#!/usr/bin/env bash\nexit 0\n';
  const tried = new Set<string>();

  for (const candidateRoot of candidateRoots) {
    if (tried.has(candidateRoot)) {
      continue;
    }
    tried.add(candidateRoot);
    try {
      fs.mkdirSync(candidateRoot, { recursive: true });
      const wrapperDir = fs.mkdtempSync(
        path.join(candidateRoot, 'ejclaw-reviewer-git-'),
      );
      const probePath = path.join(wrapperDir, 'probe');
      fs.writeFileSync(probePath, probeContents, { mode: 0o755 });
      execFileSync(probePath, [], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      fs.rmSync(probePath, { force: true });
      return wrapperDir;
    } catch {
      continue;
    }
  }

  throw new Error(
    'Unable to create an executable git guard wrapper directory for reviewer runtime.',
  );
}

export function buildReviewerGitGuardEnv(
  baseEnv: NodeJS.ProcessEnv,
  reviewerRuntime: boolean,
): NodeJS.ProcessEnv {
  if (!reviewerRuntime) {
    return baseEnv;
  }

  const realGitPath = resolveGitBinary(baseEnv);
  const protectedWorkDir = baseEnv.EJCLAW_WORK_DIR || '';
  const wrapperDir = createExecutableWrapperDir(baseEnv);
  const wrapperPath = path.join(wrapperDir, 'git');
  const blocked = [...BLOCKED_GIT_SUBCOMMANDS]
    .map((value) => `'${value}'`)
    .join(' ');

  const script = `#!/usr/bin/env bash
set -euo pipefail
real_git=${JSON.stringify(realGitPath)}
protected_work_dir=${JSON.stringify(protectedWorkDir)}
blocked_subcommands=(${blocked})
subcmd=""
skip_next=0
target_dir="$(pwd -P)"
capture_next_dir=0
for arg in "$@"; do
  if [[ "$capture_next_dir" == "1" ]]; then
    if [[ "$arg" == /* ]]; then
      target_dir="$arg"
    else
      target_dir="$target_dir/$arg"
    fi
    target_dir="$(cd "$target_dir" 2>/dev/null && pwd -P || printf '%s' "$target_dir")"
    capture_next_dir=0
    continue
  fi
  if [[ "$skip_next" == "1" ]]; then
    skip_next=0
    continue
  fi
  case "$arg" in
    -C)
      capture_next_dir=1
      continue
      ;;
    -C*)
      target_dir="\${arg#-C}"
      target_dir="$(cd "$target_dir" 2>/dev/null && pwd -P || printf '%s' "$target_dir")"
      continue
      ;;
    --work-tree)
      capture_next_dir=1
      continue
      ;;
    --work-tree=*)
      target_dir="\${arg#--work-tree=}"
      target_dir="$(cd "$target_dir" 2>/dev/null && pwd -P || printf '%s' "$target_dir")"
      continue
      ;;
    -c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env)
      skip_next=1
      continue
      ;;
    -c*|-C*|--git-dir=*|--work-tree=*|--namespace=*|--exec-path=*|--config-env=*)
      continue
      ;;
    --*)
      continue
      ;;
    -*)
      continue
      ;;
    *)
      subcmd="$arg"
      break
      ;;
  esac
done
is_protected_target=0
if [[ -n "$protected_work_dir" ]]; then
  protected_real="$(cd "$protected_work_dir" 2>/dev/null && pwd -P || printf '%s' "$protected_work_dir")"
  case "$target_dir" in
    "$protected_real"|"$protected_real"/*)
      is_protected_target=1
      ;;
  esac
fi
for blocked in "\${blocked_subcommands[@]}"; do
  if [[ "$is_protected_target" == "1" && "$subcmd" == "$blocked" ]]; then
    echo "EJClaw reviewer runtime blocks mutating git subcommands: $subcmd" >&2
    exit 1
  fi
done
exec "$real_git" "$@"
`;

  fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
  return {
    ...baseEnv,
    EJCLAW_REAL_GIT: realGitPath,
    EJCLAW_PROTECTED_WORK_DIR: protectedWorkDir,
    PATH: `${wrapperDir}:${baseEnv.PATH || ''}`,
  };
}

function readGitOutput(
  args: string[],
  baseEnv: NodeJS.ProcessEnv,
  cwd: string,
): string {
  return execFileSync('git', args, {
    cwd,
    env: baseEnv,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function isRemoteGitOrigin(originUrl: string): boolean {
  return (
    /^(?:https?|ssh|git):\/\//i.test(originUrl) ||
    /^[^/\\]+@[^:]+:.+/.test(originUrl)
  );
}

export function assertReadonlyWorkspaceRepoConnectivity(
  baseEnv: NodeJS.ProcessEnv,
  enabled: boolean,
): void {
  if (!enabled) {
    return;
  }

  const protectedWorkDir = baseEnv.EJCLAW_WORK_DIR || '';
  if (!protectedWorkDir) {
    return;
  }

  let originUrl = '';
  try {
    originUrl = readGitOutput(
      ['config', '--get', 'remote.origin.url'],
      baseEnv,
      protectedWorkDir,
    );
  } catch {
    return;
  }

  if (isRemoteGitOrigin(originUrl)) {
    return;
  }

  if (!path.isAbsolute(originUrl) || !fs.existsSync(originUrl)) {
    throw new Error(
      `EJClaw readonly runtime cannot access local git origin path: ${originUrl || '(missing)'}`,
    );
  }

  try {
    readGitOutput(['rev-parse', '--git-dir'], baseEnv, originUrl);
  } catch {
    throw new Error(
      `EJClaw readonly runtime origin path is not mounted as a git repository: ${originUrl}`,
    );
  }

  try {
    readGitOutput(['ls-remote', 'origin', 'HEAD'], baseEnv, protectedWorkDir);
  } catch {
    throw new Error(
      `EJClaw readonly runtime cannot resolve local git origin from ${protectedWorkDir}. Check canonical repo mount for ${originUrl}.`,
    );
  }
}

export function isReviewerMutatingShellCommand(command: string): boolean {
  const normalized = command.trim();
  return (
    MUTATING_SHELL_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}
