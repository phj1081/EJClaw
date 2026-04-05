/**
 * Container runner for EJClaw reviewer agents.
 *
 * Uses persistent Docker containers per channel. The container is created
 * once on first reviewer call and reused across turns. Each turn runs via
 * `docker exec` inside the warm container — no startup overhead.
 *
 *   - Source code mounted read-only (kernel-level write protection)
 *   - tmpfs overlays for test runner caches (vitest, coverage)
 *   - IPC via filesystem (input/ directory for follow-up messages)
 *   - Credentials injected by the credential proxy (never exposed to container)
 */
import { ChildProcess, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OUTPUT_END_MARKER, OUTPUT_START_MARKER } from './agent-protocol.js';
import {
  AGENT_MAX_OUTPUT_SIZE,
  AGENT_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import {
  CONTAINER_RUNTIME_BIN,
  ensureContainerRuntimeRunning,
  hostGatewayArgs,
  readonlyMountArgs,
  tmpfsMountArgs,
  writableMountArgs,
} from './container-runtime.js';
import { ensureClaudeGlobalSettingsFile } from './agent-runner-environment.js';
import { detectAuthMode } from './credential-proxy.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import type { AgentOutput } from './agent-runner.js';
import type { RegisteredGroup } from './types.js';
import { detectPnpmStorePath } from './workspace-package-manager.js';

// ── Config ────────────────────────────────────────────────────────

import { REVIEWER_CONTAINER_IMAGE as CONTAINER_IMAGE } from './config.js';

// ── Types ─────────────────────────────────────────────────────────

export interface ReviewerContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  runId: string;
  isMain: boolean;
  assistantName?: string;
  roomRoleContext?: import('./types.js').RoomRoleContext;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

interface InspectedContainerMount {
  Source?: string;
  Destination?: string;
  RW?: boolean;
}

interface InspectedContainer {
  Mounts?: InspectedContainerMount[];
}

const PRIMARY_PROJECT_MOUNT = '/workspace/project';

function pushMountOnce(mounts: VolumeMount[], mount: VolumeMount): void {
  const exists = mounts.some(
    (entry) =>
      entry.hostPath === mount.hostPath &&
      entry.containerPath === mount.containerPath &&
      entry.readonly === mount.readonly,
  );
  if (!exists) {
    mounts.push(mount);
  }
}

function normalizeLocalGitPath(remoteUrl: string): string | null {
  if (!remoteUrl) {
    return null;
  }
  if (path.isAbsolute(remoteUrl)) {
    return path.resolve(remoteUrl);
  }
  if (remoteUrl.startsWith('file://')) {
    try {
      const parsed = new URL(remoteUrl);
      if (parsed.protocol === 'file:') {
        return path.resolve(parsed.pathname);
      }
    } catch {
      return null;
    }
  }
  return null;
}

function resolveLocalOriginTarget(workspaceDir: string): string | null {
  try {
    const remoteUrl = execFileSync(
      'git',
      ['config', '--get', 'remote.origin.url'],
      {
        cwd: workspaceDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      },
    ).trim();
    const localPath = normalizeLocalGitPath(remoteUrl);
    if (!localPath || !fs.existsSync(localPath)) {
      return null;
    }
    return localPath;
  } catch {
    return null;
  }
}

function pushWorktreeGitMetadataMounts(
  mounts: VolumeMount[],
  repoDir: string,
): void {
  const dotGitPath = path.join(repoDir, '.git');
  try {
    const stat = fs.statSync(dotGitPath);
    if (!stat.isFile()) {
      return;
    }
    const content = fs.readFileSync(dotGitPath, 'utf-8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) {
      return;
    }
    const worktreeGitDir = path.resolve(repoDir, match[1]);
    const parentGitDir = path.resolve(worktreeGitDir, '..', '..');
    if (!fs.existsSync(parentGitDir)) {
      return;
    }
    pushMountOnce(mounts, {
      hostPath: parentGitDir,
      containerPath: parentGitDir,
      readonly: true,
    });
    logger.debug(
      { parentGitDir, worktreeGitDir, repoDir },
      'Mounting parent .git for worktree resolution',
    );
  } catch {
    // Not a git repo or .git missing — skip
  }
}

// ── Pre-flight checks ────────────────────────────────────────────

let containerRuntimeChecked = false;

function ensureContainerReady(): void {
  if (containerRuntimeChecked) return;
  ensureContainerRuntimeRunning();
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['image', 'inspect', CONTAINER_IMAGE], {
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch {
    throw new Error(
      `Container image '${CONTAINER_IMAGE}' not found. Build it with: ./container/build.sh`,
    );
  }
  containerRuntimeChecked = true;
}

// ── Persistent container management ──────────────────────────────

function getContainerName(groupFolder: string): string {
  return `ejclaw-reviewer-${groupFolder.replace(/[^a-zA-Z0-9-]/g, '-')}`;
}

function isContainerRunning(name: string): boolean {
  try {
    const state = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['inspect', '--format', '{{.State.Running}}', name],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
    ).trim();
    return state === 'true';
  } catch {
    return false;
  }
}

function inspectContainer(name: string): InspectedContainer | null {
  try {
    const output = execFileSync(CONTAINER_RUNTIME_BIN, ['inspect', name], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    const parsed = JSON.parse(output) as InspectedContainer[];
    return parsed[0] ?? null;
  } catch {
    return null;
  }
}

function containerHasExpectedMounts(
  name: string,
  expectedMounts: VolumeMount[],
): boolean {
  const inspection = inspectContainer(name);
  const actualMounts = inspection?.Mounts ?? [];

  return expectedMounts.every((expected) =>
    actualMounts.some(
      (actual) =>
        actual.Source === expected.hostPath &&
        actual.Destination === expected.containerPath &&
        Boolean(actual.RW) === !expected.readonly,
    ),
  );
}

function ensurePersistentContainer(
  group: RegisteredGroup,
  ownerWorkspaceDir: string,
  envOverrides?: Record<string, string>,
): string {
  const containerName = getContainerName(group.folder);
  const mounts = buildReviewerMounts(group, ownerWorkspaceDir);

  if (isContainerRunning(containerName)) {
    if (containerHasExpectedMounts(containerName, mounts)) {
      return containerName;
    }
    logger.info(
      {
        containerName,
        group: group.name,
        groupFolder: group.folder,
      },
      'Recreating persistent reviewer container because mount layout changed',
    );
  }

  // Remove stale stopped container with same name
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', containerName], {
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch {
    /* doesn't exist */
  }

  const args = buildCreateArgs(mounts, containerName);

  logger.info(
    {
      containerName,
      group: group.name,
      groupFolder: group.folder,
      image: CONTAINER_IMAGE,
      mountCount: mounts.length,
    },
    'Creating persistent reviewer container',
  );

  execFileSync(CONTAINER_RUNTIME_BIN, args, {
    stdio: 'pipe',
    timeout: 30000,
  });

  return containerName;
}

/** Stop and remove a persistent reviewer container for a channel. */
export function stopReviewerContainer(groupFolder: string): void {
  const name = getContainerName(groupFolder);
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', name], {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.info(
      { containerName: name },
      'Stopped persistent reviewer container',
    );
  } catch {
    /* already gone */
  }
}

/**
 * No-op — container recreation is no longer needed after token refresh.
 * Tokens are now synced to process.env, and `docker exec -e` injects
 * the latest token at each turn. Kept as a no-op to avoid breaking callers.
 */
export function recreateAllReviewerContainers(): void {
  // Intentionally empty — docker exec -e picks up refreshed tokens
  // from process.env without needing to recreate the container.
}

// ── Mount builder ─────────────────────────────────────────────────

export function buildReviewerMounts(
  group: RegisteredGroup,
  ownerWorkspaceDir: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const groupDir = resolveGroupFolderPath(group.folder);
  const groupIpcDir = resolveGroupIpcPath(group.folder);

  // Source code: READ-ONLY (kernel-level protection)
  pushMountOnce(mounts, {
    hostPath: ownerWorkspaceDir,
    containerPath: PRIMARY_PROJECT_MOUNT,
    readonly: true,
  });
  const canonicalRepoDir = resolveLocalOriginTarget(ownerWorkspaceDir);
  if (
    canonicalRepoDir &&
    canonicalRepoDir !== ownerWorkspaceDir &&
    canonicalRepoDir !== PRIMARY_PROJECT_MOUNT
  ) {
    pushMountOnce(mounts, {
      hostPath: canonicalRepoDir,
      containerPath: canonicalRepoDir,
      readonly: true,
    });
  }
  // Compatibility mount: expose the owner workspace at the same absolute path
  // inside the container so owner-authored absolute paths still resolve.
  if (ownerWorkspaceDir !== PRIMARY_PROJECT_MOUNT) {
    pushMountOnce(mounts, {
      hostPath: ownerWorkspaceDir,
      containerPath: ownerWorkspaceDir,
      readonly: true,
    });
  }

  // Git worktree support: worktree's .git file references the parent repo's
  // .git directory via absolute path. Mount the parent .git at the same host
  // path so git commands resolve inside the container.
  pushWorktreeGitMetadataMounts(mounts, ownerWorkspaceDir);
  if (canonicalRepoDir) {
    pushWorktreeGitMetadataMounts(mounts, canonicalRepoDir);
  }

  // pnpm global store: mount at the same host path so hardlinks resolve.
  const pnpmStore = detectPnpmStorePath(ownerWorkspaceDir);
  if (pnpmStore) {
    pushMountOnce(mounts, {
      hostPath: pnpmStore,
      containerPath: pnpmStore,
      readonly: true,
    });
    logger.debug({ pnpmStore }, 'Mounting pnpm store for container');
  }

  // Shadow .env so reviewer cannot read secrets from mounted project
  const envFile = path.join(ownerWorkspaceDir, '.env');
  const shadowPaths = new Set<string>();
  if (fs.existsSync(envFile)) {
    shadowPaths.add(path.join(PRIMARY_PROJECT_MOUNT, '.env'));
    shadowPaths.add(path.join(ownerWorkspaceDir, '.env'));
  }
  const canonicalEnvFile = canonicalRepoDir
    ? path.join(canonicalRepoDir, '.env')
    : null;
  if (canonicalEnvFile && fs.existsSync(canonicalEnvFile)) {
    shadowPaths.add(canonicalEnvFile);
  }
  for (const shadowPath of shadowPaths) {
    pushMountOnce(mounts, {
      hostPath: '/dev/null',
      containerPath: shadowPath,
      readonly: true,
    });
  }

  // Attachments directory: read-only (Discord file uploads downloaded here)
  const attachmentsDir = path.join(DATA_DIR, 'attachments');
  if (fs.existsSync(attachmentsDir)) {
    pushMountOnce(mounts, {
      hostPath: attachmentsDir,
      containerPath: attachmentsDir,
      readonly: true,
    });
  }

  // Group folder: writable (logs, session data)
  pushMountOnce(mounts, {
    hostPath: groupDir,
    containerPath: '/workspace/group',
    readonly: false,
  });

  // IPC directory: writable (output messages, task results)
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  pushMountOnce(mounts, {
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Global memory: read-only
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    pushMountOnce(mounts, {
      hostPath: globalDir,
      containerPath: '/workspace/global',
      readonly: true,
    });
  }

  // Session directory for Claude/Codex state.
  // Use the reviewer-suffixed path to match paired-execution-context.ts
  // which writes CLAUDE.md (prompts) to {folder}-reviewer/.claude/.
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    `${group.folder}-reviewer`,
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  ensureClaudeGlobalSettingsFile(groupSessionsDir);
  pushMountOnce(mounts, {
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });
  pushMountOnce(mounts, {
    hostPath: path.join(groupSessionsDir, '.claude.json'),
    containerPath: '/home/node/.claude.json',
    readonly: false,
  });

  // Owner session directory: read-only so reviewer can verify runtime state
  // files (cron state, configs, etc.) that the owner references by absolute path.
  const ownerSessionDir = path.join(DATA_DIR, 'sessions', group.folder);
  if (fs.existsSync(ownerSessionDir)) {
    pushMountOnce(mounts, {
      hostPath: ownerSessionDir,
      containerPath: ownerSessionDir,
      readonly: true,
    });
  }

  // Codex OAuth: mount host's ~/.codex (read-only) so codex-runner can authenticate
  const hostCodexHome =
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (fs.existsSync(hostCodexHome)) {
    pushMountOnce(mounts, {
      hostPath: hostCodexHome,
      containerPath: '/home/node/.codex',
      readonly: true,
    });
  }

  return mounts;
}

// ── Container args builders ──────────────────────────────────────

/** Build args for `docker run -d` (create persistent container). */
export function buildCreateArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  // Start detached with sleep infinity — turns run via docker exec
  const args: string[] = [
    'run',
    '-d',
    '--name',
    containerName,
    '--entrypoint',
    'sleep',
  ];

  // Timezone
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass real credentials — Claude Code SDK handles OAuth internally,
  // raw Bearer tokens on api.anthropic.com are not supported.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    args.push('-e', `ANTHROPIC_API_KEY=${apiKey}`);
  } else {
    const oauthToken =
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      '';
    args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`);
  }

  // Sentry read-only token for reviewer to verify error fixes
  if (process.env.SENTRY_AUTH_TOKEN) {
    args.push('-e', `SENTRY_AUTH_TOKEN=${process.env.SENTRY_AUTH_TOKEN}`);
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // Run as host user for bind-mount compatibility
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push(...writableMountArgs(mount.hostPath, mount.containerPath));
    }
  }

  // Writable tmpfs for test runners and temp files
  args.push(...tmpfsMountArgs('/tmp'));
  args.push('-e', 'VITEST_CACHE_DIR=/tmp/.vitest');
  args.push('-e', 'JEST_CACHE_DIR=/tmp/.jest');
  args.push('-e', 'npm_config_cache=/tmp/.npm');

  args.push(CONTAINER_IMAGE);
  args.push('infinity'); // argument to sleep

  return args;
}

export function appendExecEnvArgs(
  execArgs: string[],
  envOverrides: Record<string, string> | undefined,
  isCodexAgent: boolean,
): void {
  if (!envOverrides) {
    return;
  }

  const ignoredKeys = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  const incompatibleModelKeys = isCodexAgent
    ? new Set(['CLAUDE_MODEL', 'CLAUDE_EFFORT'])
    : new Set(['CODEX_MODEL', 'CODEX_EFFORT']);

  for (const [key, value] of Object.entries(envOverrides)) {
    if (!value || ignoredKeys.has(key) || incompatibleModelKeys.has(key)) {
      continue;
    }
    if (key === 'CLAUDE_CONFIG_DIR') {
      execArgs.push('-e', 'CLAUDE_CONFIG_DIR=/home/node/.claude');
      continue;
    }
    execArgs.push('-e', `${key}=${value}`);
  }
}

// ── Main runner ───────────────────────────────────────────────────

export async function runReviewerContainer(args: {
  group: RegisteredGroup;
  input: ReviewerContainerInput;
  ownerWorkspaceDir: string;
  envOverrides?: Record<string, string>;
  onOutput?: (output: AgentOutput) => Promise<void>;
  onProcess?: (proc: ChildProcess, containerName: string) => void;
}): Promise<AgentOutput> {
  const { group, input, ownerWorkspaceDir, envOverrides, onOutput, onProcess } =
    args;
  const startTime = Date.now();

  // Pre-flight: Docker running + image exists (cached after first check)
  ensureContainerReady();

  // Ensure persistent container is running for this channel
  const containerName = ensurePersistentContainer(
    group,
    ownerWorkspaceDir,
    envOverrides,
  );

  logger.info(
    {
      containerName,
      group: group.name,
      groupFolder: group.folder,
      chatJid: input.chatJid,
      runId: input.runId,
    },
    'Executing reviewer turn in persistent container',
  );

  // Run a turn inside the persistent container via docker exec.
  // Inject credentials and model config at exec-time so token rotation
  // and per-role model overrides are picked up without recreating the container.
  const execArgs = ['exec', '-i'];
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    execArgs.push(
      '-e',
      `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY || ''}`,
    );
  } else {
    const oauthToken =
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      '';
    execArgs.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`);
  }
  const isCodexAgent = (group.agentType || 'claude-code') === 'codex';
  logger.info(
    {
      containerName,
      groupAgentType: group.agentType,
      isCodexAgent,
      runnerPath: isCodexAgent
        ? '/app/codex/dist/index.js'
        : '/app/agent/dist/index.js',
    },
    'Container exec runner selection',
  );
  appendExecEnvArgs(execArgs, envOverrides, isCodexAgent);
  if (isCodexAgent) {
    // Use session-local .codex dir (contains AGENTS.md with role prompts)
    // instead of the host-mounted ~/.codex (which has owner-only config).
    execArgs.push('-e', 'CODEX_HOME=/home/node/.claude/.codex');
  }
  const runnerPath = isCodexAgent
    ? '/app/codex/dist/index.js'
    : '/app/agent/dist/index.js';
  execArgs.push(containerName, 'bun', runnerPath);

  return new Promise<AgentOutput>((resolve) => {
    const proc = spawn(CONTAINER_RUNTIME_BIN, execArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess?.(proc, containerName);

    // Send input via stdin
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let lastOutput: AgentOutput | null = null;
    let totalOutputSize = 0;
    let parseBuffer = '';
    let outputChain = Promise.resolve();

    // Streaming output: parse OUTPUT_START/END marker pairs
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      totalOutputSize += text.length;

      if (totalOutputSize > AGENT_MAX_OUTPUT_SIZE) {
        logger.warn(
          { containerName, size: totalOutputSize },
          'Container output exceeds max size, killing exec',
        );
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        return;
      }

      stdout += text;
      parseBuffer += text;
      resetTimeout();

      let startIdx: number;
      while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break;

        const json = parseBuffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

        try {
          const parsed = JSON.parse(json) as AgentOutput;
          lastOutput = parsed;
          if (onOutput) {
            outputChain = outputChain.then(() => onOutput(parsed));
          }
        } catch (err) {
          logger.warn(
            { containerName, err },
            'Failed to parse container output JSON',
          );
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      resetTimeout();
    });

    // Activity-based timeout
    const timeoutMs = Math.max(AGENT_TIMEOUT, IDLE_TIMEOUT + 30_000);
    const killOnTimeout = () => {
      logger.warn(
        { containerName, timeoutMs },
        'Reviewer exec timed out, killing',
      );
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    };
    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.on('close', (code, signal) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startTime;

      logger.info(
        {
          containerName,
          group: group.name,
          runId: input.runId,
          exitCode: code,
          signal,
          durationMs,
          stdoutLen: stdout.length,
          stderrLen: stderr.length,
        },
        'Reviewer exec completed',
      );

      if (lastOutput) {
        outputChain.then(() => resolve(lastOutput!));
        return;
      }

      // Fallback: try to parse from full stdout
      const sIdx = stdout.indexOf(OUTPUT_START_MARKER);
      const eIdx = stdout.indexOf(OUTPUT_END_MARKER);
      if (sIdx !== -1 && eIdx !== -1) {
        try {
          const json = stdout
            .slice(sIdx + OUTPUT_START_MARKER.length, eIdx)
            .trim();
          resolve(JSON.parse(json) as AgentOutput);
          return;
        } catch {
          /* fall through */
        }
      }

      const errorMsg = stderr.trim() || `Exec exited with code ${code}`;
      resolve({
        status: code === 0 ? 'success' : 'error',
        result: null,
        error: errorMsg,
        phase: 'final',
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ containerName, err }, 'Failed to exec in container');
      resolve({
        status: 'error',
        result: null,
        error: `Container exec error: ${err.message}`,
        phase: 'final',
      });
    });
  });
}
