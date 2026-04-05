import { execFile, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { REVIEWER_CONTAINER_IMAGE, TIMEZONE } from './config.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  tmpfsMountArgs,
  writableMountArgs,
} from './container-runtime.js';
import { resolveGroupIpcPath } from './group-folder.js';
import {
  buildWorkspaceScriptCommand,
  detectPnpmStorePath,
  hasInstalledNodeModules,
} from './workspace-package-manager.js';

export const VERIFICATION_PROFILES = ['test', 'typecheck', 'build'] as const;

export type VerificationProfile = (typeof VERIFICATION_PROFILES)[number];

export interface VerificationRequest {
  requestId: string;
  profile: VerificationProfile;
  expectedSnapshotId?: string;
}

export interface VerificationResult {
  ok: boolean;
  profile: VerificationProfile;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  snapshotId: string;
  runtimeVersion: string;
  workdir?: string;
  error?: string;
}

export interface VerificationResponse extends VerificationResult {
  requestId: string;
}

export interface VerificationSnapshot {
  snapshotId: string;
}

interface VerificationCommandSpec {
  file: string;
  args: string[];
  commandText: string;
  requiredScript: string;
}

const PRIMARY_PROJECT_MOUNT = '/workspace/project';
const SNAPSHOT_EXCLUDE_NAMES = new Set(['.git', 'node_modules', '.env']);
const MAX_OUTPUT_CHARS = 24_000;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const COMMAND_MAX_BUFFER = 20 * 1024 * 1024;

export function isVerificationProfile(
  value: unknown,
): value is VerificationProfile {
  return (
    typeof value === 'string' &&
    VERIFICATION_PROFILES.includes(value as VerificationProfile)
  );
}

export function buildVerificationCommand(
  profile: VerificationProfile,
  repoDir: string = process.cwd(),
): VerificationCommandSpec {
  const scriptName =
    profile === 'test' ? 'test' : profile === 'typecheck' ? 'typecheck' : 'build';
  const command = buildWorkspaceScriptCommand(repoDir, scriptName);
  return {
    file: command.file,
    args: command.args,
    commandText: command.commandText,
    requiredScript: scriptName,
  };
}

function shouldExcludePath(name: string): boolean {
  return SNAPSHOT_EXCLUDE_NAMES.has(name);
}

function updateSnapshotHash(
  hash: ReturnType<typeof createHash>,
  repoDir: string,
  currentPath: string,
): void {
  const relPath = path.relative(repoDir, currentPath) || '.';
  const stat = fs.lstatSync(currentPath);

  if (stat.isDirectory()) {
    if (relPath !== '.') {
      hash.update(`dir\0${relPath}\0`);
    }
    for (const entry of fs.readdirSync(currentPath).sort()) {
      if (shouldExcludePath(entry)) continue;
      updateSnapshotHash(hash, repoDir, path.join(currentPath, entry));
    }
    return;
  }

  if (stat.isSymbolicLink()) {
    hash.update(`symlink\0${relPath}\0${fs.readlinkSync(currentPath)}\0`);
    return;
  }

  if (stat.isFile()) {
    hash.update(`file\0${relPath}\0`);
    hash.update(fs.readFileSync(currentPath));
    hash.update('\0');
  }
}

export function computeVerificationSnapshot(
  repoDir: string,
): VerificationSnapshot {
  const hash = createHash('sha256');
  updateSnapshotHash(hash, repoDir, repoDir);
  return {
    snapshotId: `fs:${hash.digest('hex').slice(0, 24)}`,
  };
}

function truncateOutput(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
}

function readPackageScripts(repoDir: string): Record<string, string> {
  const packageJsonPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return {};
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts || {};
}

function copyWorkspaceToScratch(repoDir: string, scratchDir: string): void {
  fs.cpSync(repoDir, scratchDir, {
    recursive: true,
    filter: (source) => {
      if (source === repoDir) return true;
      return !shouldExcludePath(path.basename(source));
    },
  });
}

function detectRuntimeVersion(): string {
  try {
    const imageId = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['image', 'inspect', REVIEWER_CONTAINER_IMAGE, '--format', '{{.Id}}'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      },
    ).trim();
    return `${REVIEWER_CONTAINER_IMAGE}@${imageId}`;
  } catch {
    return REVIEWER_CONTAINER_IMAGE;
  }
}

function buildDockerRunArgs(
  scratchWorkspace: string,
  sourceRepoDir: string,
): string[] {
  const args = [
    'run',
    '--rm',
    '-i',
    '--workdir',
    PRIMARY_PROJECT_MOUNT,
    '-e',
    `TZ=${TIMEZONE}`,
    '-e',
    'CI=1',
    '-e',
    'VITEST_CACHE_DIR=/tmp/.vitest',
    '-e',
    'JEST_CACHE_DIR=/tmp/.jest',
    '-e',
    'npm_config_cache=/tmp/.npm',
  ];

  args.push(...hostGatewayArgs());

  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  args.push(...writableMountArgs(scratchWorkspace, PRIMARY_PROJECT_MOUNT));

  const sourceNodeModulesDir = path.join(sourceRepoDir, 'node_modules');
  if (
    hasInstalledNodeModules(sourceRepoDir) &&
    fs.existsSync(sourceNodeModulesDir)
  ) {
    args.push(
      ...readonlyMountArgs(
        sourceNodeModulesDir,
        path.join(PRIMARY_PROJECT_MOUNT, 'node_modules'),
      ),
    );
  }

  const pnpmStore = detectPnpmStorePath(sourceRepoDir);
  if (pnpmStore) {
    args.push(...readonlyMountArgs(pnpmStore, pnpmStore));
  }

  args.push(...tmpfsMountArgs('/tmp'));

  return args;
}

function execFileCapture(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(error, {
              stdout,
              stderr,
            }),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function extractExitCode(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      return code;
    }
  }
  return 1;
}

export async function runVerificationRequest(
  request: VerificationRequest,
  options?: {
    repoDir?: string;
  },
): Promise<VerificationResult> {
  const repoDir = options?.repoDir || process.cwd();
  const runtimeVersion = detectRuntimeVersion();
  const command = buildVerificationCommand(request.profile, repoDir);
  const scripts = readPackageScripts(repoDir);

  if (!scripts[command.requiredScript]) {
    return {
      ok: false,
      profile: request.profile,
      command: command.commandText,
      stdout: '',
      stderr: '',
      exitCode: 1,
      snapshotId: 'unknown',
      runtimeVersion,
      error: `Verification profile "${request.profile}" is not configured in package.json scripts.`,
    };
  }

  if (!hasInstalledNodeModules(repoDir)) {
    return {
      ok: false,
      profile: request.profile,
      command: command.commandText,
      stdout: '',
      stderr: '',
      exitCode: 1,
      snapshotId: 'unknown',
      runtimeVersion,
      error:
        'Verification shim requires an installed node_modules tree in the workspace.',
    };
  }

  const beforeSnapshot = computeVerificationSnapshot(repoDir);
  if (
    request.expectedSnapshotId &&
    beforeSnapshot.snapshotId !== request.expectedSnapshotId
  ) {
    return {
      ok: false,
      profile: request.profile,
      command: command.commandText,
      stdout: '',
      stderr: '',
      exitCode: 1,
      snapshotId: beforeSnapshot.snapshotId,
      runtimeVersion,
      error: `Snapshot mismatch before verification. expected=${request.expectedSnapshotId} current=${beforeSnapshot.snapshotId}`,
    };
  }

  const scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ejclaw-verification-'),
  );
  const scratchWorkspace = path.join(scratchRoot, 'workspace');

  try {
    copyWorkspaceToScratch(repoDir, scratchWorkspace);

    const afterSnapshot = computeVerificationSnapshot(repoDir);
    if (afterSnapshot.snapshotId !== beforeSnapshot.snapshotId) {
      return {
        ok: false,
        profile: request.profile,
        command: command.commandText,
        stdout: '',
        stderr: '',
        exitCode: 1,
        snapshotId: afterSnapshot.snapshotId,
        runtimeVersion,
        error: `Workspace changed while preparing verification scratch. expected=${beforeSnapshot.snapshotId} current=${afterSnapshot.snapshotId}`,
      };
    }

    const dockerArgs = buildDockerRunArgs(scratchWorkspace, repoDir);
    dockerArgs.push(REVIEWER_CONTAINER_IMAGE, command.file, ...command.args);

    try {
      const { stdout, stderr } = await execFileCapture(
        CONTAINER_RUNTIME_BIN,
        dockerArgs,
      );
      return {
        ok: true,
        profile: request.profile,
        command: command.commandText,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: 0,
        snapshotId: beforeSnapshot.snapshotId,
        runtimeVersion,
      };
    } catch (error) {
      const stdout =
        typeof error === 'object' && error !== null && 'stdout' in error
          ? String((error as { stdout?: unknown }).stdout ?? '')
          : '';
      const stderr =
        typeof error === 'object' && error !== null && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '')
          : '';

      return {
        ok: false,
        profile: request.profile,
        command: command.commandText,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: extractExitCode(error),
        snapshotId: beforeSnapshot.snapshotId,
        runtimeVersion,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

export function resolveVerificationResponseDir(groupFolder: string): string {
  return path.join(resolveGroupIpcPath(groupFolder), 'verification-responses');
}

export function writeVerificationResponse(
  groupFolder: string,
  response: VerificationResponse,
): string {
  const responseDir = resolveVerificationResponseDir(groupFolder);
  fs.mkdirSync(responseDir, { recursive: true });

  const outputPath = path.join(responseDir, `${response.requestId}.json`);
  const tempPath = `${outputPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(response, null, 2));
  fs.renameSync(tempPath, outputPath);
  return outputPath;
}
