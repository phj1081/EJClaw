/**
 * Container runner for EJClaw reviewer agents.
 *
 * Spawns reviewer execution inside a Docker container with:
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
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  ensureContainerRuntimeRunning,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
  tmpfsMountArgs,
  writableMountArgs,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import type { AgentOutput } from './agent-runner.js';
import type { RegisteredGroup } from './types.js';

// ── Config ────────────────────────────────────────────────────────

const CONTAINER_IMAGE =
  process.env.REVIEWER_CONTAINER_IMAGE || 'ejclaw-reviewer:latest';
const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);

// ── Types ─────────────────────────────────────────────────────────

export interface ReviewerContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  runId: string;
  isMain: boolean;
  assistantName?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

// ── pnpm store detection ─────────────────────────────────────────

function detectPnpmStorePath(workspaceDir: string): string | null {
  if (!fs.existsSync(path.join(workspaceDir, 'pnpm-lock.yaml'))) {
    return null;
  }
  // Check env override first
  if (process.env.PNPM_STORE_DIR && fs.existsSync(process.env.PNPM_STORE_DIR)) {
    return process.env.PNPM_STORE_DIR;
  }
  // Try `pnpm store path`
  try {
    const storePath = execFileSync('pnpm', ['store', 'path'], {
      cwd: workspaceDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    if (storePath && fs.existsSync(storePath)) return storePath;
  } catch {
    /* pnpm not available */
  }
  // Fallback to default location
  const defaultStore = path.join(
    os.homedir(),
    '.local',
    'share',
    'pnpm',
    'store',
  );
  if (fs.existsSync(defaultStore)) return defaultStore;
  return null;
}

// ── Pre-flight checks ────────────────────────────────────────────

let containerRuntimeChecked = false;

function ensureContainerReady(): void {
  if (containerRuntimeChecked) return;
  ensureContainerRuntimeRunning();
  // Check image exists
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

// ── Mount builder ─────────────────────────────────────────────────

export function buildReviewerMounts(
  group: RegisteredGroup,
  ownerWorkspaceDir: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const groupDir = resolveGroupFolderPath(group.folder);
  const groupIpcDir = resolveGroupIpcPath(group.folder);

  // Source code: READ-ONLY (kernel-level protection)
  // Includes node_modules if present (npm/yarn/bun are self-contained)
  mounts.push({
    hostPath: ownerWorkspaceDir,
    containerPath: '/workspace/project',
    readonly: true,
  });

  // pnpm global store: mount at the same host path so hardlinks resolve.
  // Only needed for pnpm — npm/yarn/bun have self-contained node_modules.
  const pnpmStore = detectPnpmStorePath(ownerWorkspaceDir);
  if (pnpmStore) {
    mounts.push({
      hostPath: pnpmStore,
      containerPath: pnpmStore,
      readonly: true,
    });
    logger.debug({ pnpmStore }, 'Mounting pnpm store for container');
  }

  // Shadow .env so reviewer cannot read secrets from mounted project
  const envFile = path.join(ownerWorkspaceDir, '.env');
  if (fs.existsSync(envFile)) {
    mounts.push({
      hostPath: '/dev/null',
      containerPath: '/workspace/project/.env',
      readonly: true,
    });
  }

  // Group folder: writable (logs, session data)
  mounts.push({
    hostPath: groupDir,
    containerPath: '/workspace/group',
    readonly: false,
  });

  // IPC directory: writable (output messages, task results)
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Global memory: read-only
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({
      hostPath: globalDir,
      containerPath: '/workspace/global',
      readonly: true,
    });
  }

  // Session directory for Claude/Codex state
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder);
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  return mounts;
}

// ── Container args builder ────────────────────────────────────────

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  envOverrides?: Record<string, string>,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Timezone
  args.push('-e', `TZ=${TIMEZONE}`);

  // Credential proxy — containers never see real API keys
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Reviewer runtime flag
  args.push('-e', 'EJCLAW_REVIEWER_RUNTIME=1');

  // Extra env overrides from paired-execution-context
  if (envOverrides) {
    for (const [key, value] of Object.entries(envOverrides)) {
      if (
        key === 'ANTHROPIC_BASE_URL' ||
        key === 'ANTHROPIC_API_KEY' ||
        key === 'CLAUDE_CODE_OAUTH_TOKEN'
      )
        continue;
      // Remap host paths to container mount points
      if (key === 'EJCLAW_WORK_DIR') {
        args.push('-e', 'EJCLAW_WORK_DIR=/workspace/project');
        continue;
      }
      if (key === 'CLAUDE_CONFIG_DIR') {
        args.push('-e', 'CLAUDE_CONFIG_DIR=/home/node/.claude');
        continue;
      }
      args.push('-e', `${key}=${value}`);
    }
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

  // Writable tmpfs for test runners and temp files.
  // Cannot mount tmpfs inside :ro mount, so redirect caches via env vars.
  args.push(...tmpfsMountArgs('/tmp'));
  args.push('-e', 'VITEST_CACHE_DIR=/tmp/.vitest');
  args.push('-e', 'JEST_CACHE_DIR=/tmp/.jest');
  args.push('-e', 'npm_config_cache=/tmp/.npm');

  args.push(CONTAINER_IMAGE);

  return args;
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
  const containerName = `ejclaw-reviewer-${group.folder}-${Date.now()}`;

  // Pre-flight: Docker running + image exists (cached after first check)
  ensureContainerReady();

  const mounts = buildReviewerMounts(group, ownerWorkspaceDir);
  const containerArgs = buildContainerArgs(mounts, containerName, envOverrides);

  logger.info(
    {
      containerName,
      group: group.name,
      groupFolder: group.folder,
      chatJid: input.chatJid,
      runId: input.runId,
      image: CONTAINER_IMAGE,
      mountCount: mounts.length,
    },
    'Spawning reviewer container',
  );

  return new Promise<AgentOutput>((resolve) => {
    const proc = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess?.(proc, containerName);

    // Send input via stdin
    const stdinPayload = JSON.stringify(input);
    proc.stdin.write(stdinPayload);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let lastOutput: AgentOutput | null = null;
    let totalOutputSize = 0;
    let parseBuffer = '';
    // Chain onOutput calls so all async work (message delivery, DB writes)
    // completes before the container exit handler runs. Without this,
    // work items are still 'produced' when the drain loop checks, causing
    // duplicate deliveries through different channels.
    let outputChain = Promise.resolve();

    // Streaming output: parse OUTPUT_START/END marker pairs
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      totalOutputSize += text.length;

      if (totalOutputSize > AGENT_MAX_OUTPUT_SIZE) {
        logger.warn(
          { containerName, size: totalOutputSize },
          'Container output exceeds max size, killing',
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

      // Parse streamed output markers
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
      // Stderr activity means agent is alive — reset idle timeout
      resetTimeout();
    });

    // Activity-based timeout: reset on stdout/stderr data
    const timeoutMs = Math.max(AGENT_TIMEOUT, IDLE_TIMEOUT + 30_000);
    const killOnTimeout = () => {
      logger.warn(
        { containerName, timeoutMs },
        'Reviewer container timed out, stopping',
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
        'Reviewer container exited',
      );

      if (lastOutput) {
        // Wait for all queued onOutput handlers to finish so work items
        // are marked delivered before the caller proceeds to drain.
        outputChain.then(() => resolve(lastOutput!));
        return;
      }

      // Fallback: try to parse from full stdout
      const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
      const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
      if (startIdx !== -1 && endIdx !== -1) {
        try {
          const json = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          resolve(JSON.parse(json) as AgentOutput);
          return;
        } catch {
          /* fall through */
        }
      }

      // No valid output
      const errorMsg = stderr.trim() || `Container exited with code ${code}`;
      resolve({
        status: code === 0 ? 'success' : 'error',
        result: null,
        error: errorMsg,
        phase: 'final',
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { containerName, err },
        'Failed to spawn reviewer container',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
        phase: 'final',
      });
    });
  });
}
