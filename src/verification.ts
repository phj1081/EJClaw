import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { TIMEZONE } from './config.js';
import {
  buildWorkspaceCommandEnvironment,
  buildWorkspaceScriptCommand,
  ensureWorkspaceDependenciesInstalled,
  hasInstalledNodeModules,
  type WorkspacePackageManager,
} from './workspace-package-manager.js';
import { computeVerificationSnapshotId } from '../shared/verification-snapshot.js';

export const VERIFICATION_PROFILES = [
  'test',
  'typecheck',
  'build',
  'lint',
] as const;

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

export interface VerificationSnapshot {
  snapshotId: string;
}

interface VerificationCommandSpec {
  packageManager: WorkspacePackageManager;
  file: string;
  args: string[];
  commandText: string;
  requiredScript: string;
}
type DirectExecutionEnvKey =
  | 'PATH'
  | 'HOME'
  | 'USER'
  | 'LOGNAME'
  | 'SHELL'
  | 'LANG'
  | 'LC_ALL'
  | 'LC_CTYPE'
  | 'NODE_PATH'
  | 'NODE_OPTIONS'
  | 'TERM'
  | 'COLORTERM'
  | 'FORCE_COLOR';

const MAX_OUTPUT_CHARS = 24_000;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const COMMAND_MAX_BUFFER = 20 * 1024 * 1024;
const DIRECT_EXECUTION_ENV_KEYS: readonly DirectExecutionEnvKey[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_PATH',
  'NODE_OPTIONS',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
];

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
  const scripts = readPackageScripts(repoDir);
  const scriptName =
    profile === 'test'
      ? 'test'
      : profile === 'typecheck'
        ? 'typecheck'
        : profile === 'build'
          ? 'build'
          : scripts['lint:ci']
            ? 'lint:ci'
            : scripts['lint:check']
              ? 'lint:check'
              : 'lint';
  const command = buildWorkspaceScriptCommand(repoDir, scriptName);
  return {
    packageManager: command.packageManager,
    file: command.file,
    args: command.args,
    commandText: command.commandText,
    requiredScript: scriptName,
  };
}

export function computeVerificationSnapshot(
  repoDir: string,
): VerificationSnapshot {
  return {
    snapshotId: computeVerificationSnapshotId(repoDir),
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

function detectDirectRuntimeVersion(
  command: Pick<VerificationCommandSpec, 'file'>,
): string {
  try {
    switch (command.file) {
      case 'bun': {
        const bunVersion = execFileSync('bun', ['--version'], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000,
        }).trim();
        return `host:bun@${bunVersion}`;
      }
      case 'node':
        return `host:node@${process.version}`;
      default:
        return `host:${command.file}`;
    }
  } catch {
    return `host:${command.file}`;
  }
}

function buildDirectExecutionEnvironment(): {
  env: NodeJS.ProcessEnv;
  tempRoot: string;
} {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ejclaw-verification-runtime-'),
  );
  const env: NodeJS.ProcessEnv = {
    TZ: TIMEZONE,
    CI: '1',
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
    VITEST_CACHE_DIR: path.join(tempRoot, '.vitest'),
    JEST_CACHE_DIR: path.join(tempRoot, '.jest'),
    npm_config_cache: path.join(tempRoot, '.npm'),
    npm_config_userconfig: path.join(tempRoot, '.npmrc'),
    BUN_INSTALL_CACHE_DIR: path.join(tempRoot, '.bun'),
    XDG_CACHE_HOME: path.join(tempRoot, '.cache'),
    COREPACK_HOME: path.join(tempRoot, '.corepack'),
    PNPM_HOME: path.join(tempRoot, '.pnpm-home'),
    YARN_CACHE_FOLDER: path.join(tempRoot, '.yarn-cache'),
  };

  for (const key of DIRECT_EXECUTION_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  return {
    tempRoot,
    env,
  };
}

function execFileCapture(
  file: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
        cwd: options?.cwd,
        env: options?.env,
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
  const command = buildVerificationCommand(request.profile, repoDir);
  const runtimeVersion = detectDirectRuntimeVersion(command);
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
    try {
      ensureWorkspaceDependenciesInstalled(repoDir);
    } catch (error) {
      return {
        ok: false,
        profile: request.profile,
        command: command.commandText,
        stdout: '',
        stderr: '',
        exitCode: 1,
        snapshotId: 'unknown',
        runtimeVersion,
        error: error instanceof Error ? error.message : String(error),
      };
    }
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

  const directExecution = buildDirectExecutionEnvironment();

  try {
    try {
      const { stdout, stderr } = await execFileCapture(
        command.file,
        command.args,
        {
          cwd: repoDir,
          env: buildWorkspaceCommandEnvironment(
            repoDir,
            command.packageManager,
            directExecution.env,
          ),
        },
      );
      const afterSnapshot = computeVerificationSnapshot(repoDir);
      if (afterSnapshot.snapshotId !== beforeSnapshot.snapshotId) {
        return {
          ok: false,
          profile: request.profile,
          command: command.commandText,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
          exitCode: 1,
          snapshotId: afterSnapshot.snapshotId,
          runtimeVersion,
          error: `Workspace changed during verification. expected=${beforeSnapshot.snapshotId} current=${afterSnapshot.snapshotId}`,
        };
      }

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
      const afterSnapshot = computeVerificationSnapshot(repoDir);
      const workspaceChanged =
        afterSnapshot.snapshotId !== beforeSnapshot.snapshotId;

      return {
        ok: false,
        profile: request.profile,
        command: command.commandText,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: extractExitCode(error),
        snapshotId: workspaceChanged
          ? afterSnapshot.snapshotId
          : beforeSnapshot.snapshotId,
        runtimeVersion,
        error: workspaceChanged
          ? `Workspace changed during verification. expected=${beforeSnapshot.snapshotId} current=${afterSnapshot.snapshotId}`
          : error instanceof Error
            ? error.message
            : String(error),
      };
    }
  } finally {
    fs.rmSync(directExecution.tempRoot, { recursive: true, force: true });
  }
}
