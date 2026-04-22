import { execFile } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';
export { computeVerificationSnapshotId } from '../../../shared/verification-snapshot.js';

export const VERIFICATION_PROFILES = [
  'test',
  'typecheck',
  'build',
  'lint',
] as const;

export type VerificationProfile = (typeof VERIFICATION_PROFILES)[number];

type VerificationHelperEnvKey =
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

const VERIFICATION_HELPER_ENV_KEYS: readonly VerificationHelperEnvKey[] = [
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
const HELPER_TIMEOUT_MS = 20 * 60 * 1000;
const HELPER_MAX_BUFFER = 20 * 1024 * 1024;

export interface VerificationRequest {
  requestId: string;
  profile: VerificationProfile;
  expectedSnapshotId?: string;
}

export interface VerificationResponse {
  requestId: string;
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

export function isVerificationProfile(
  value: unknown,
): value is VerificationProfile {
  return (
    typeof value === 'string' &&
    VERIFICATION_PROFILES.includes(value as VerificationProfile)
  );
}

function buildVerificationHelperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    TZ: 'Asia/Seoul',
    CI: '1',
  };

  for (const key of VERIFICATION_HELPER_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  return env;
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
        timeout: HELPER_TIMEOUT_MS,
        maxBuffer: HELPER_MAX_BUFFER,
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

export async function runVerificationRequestDirect(
  repoRoot: string,
  request: VerificationRequest,
): Promise<VerificationResponse> {
  const helperPath = path.join(
    repoRoot,
    'shared',
    'verification-request-runner.js',
  );
  const helperEnv = buildVerificationHelperEnv();
  const { stdout, stderr } = await execFileCapture(
    'bun',
    [helperPath, repoRoot, JSON.stringify(request)],
    {
      cwd: repoRoot,
      env: helperEnv,
    },
  );

  try {
    return JSON.parse(stdout) as VerificationResponse;
  } catch (error) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(
      `Failed to parse verification response from ${pathToFileURL(helperPath).href}: ${
        error instanceof Error ? error.message : String(error)
      }${detail ? `\n${detail}` : ''}`,
    );
  }
}

export function formatVerificationResponse(
  response: VerificationResponse,
): string {
  const parts = [
    `Verification profile: ${response.profile}`,
    `Snapshot: ${response.snapshotId}`,
    `Runtime: ${response.runtimeVersion}`,
    `Exit code: ${response.exitCode}`,
    response.workdir ? `Workdir: ${response.workdir}` : null,
    response.command ? `$ ${response.command}` : null,
    response.stdout ? response.stdout.trimEnd() : null,
    response.stderr ? `[stderr]\n${response.stderr.trimEnd()}` : null,
    response.error ? `[error] ${response.error}` : null,
  ].filter((value): value is string => Boolean(value));

  return parts.join('\n');
}
