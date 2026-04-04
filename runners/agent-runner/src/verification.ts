import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

export const VERIFICATION_PROFILES = [
  'test',
  'typecheck',
  'build',
] as const;

export type VerificationProfile = (typeof VERIFICATION_PROFILES)[number];

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

const SNAPSHOT_EXCLUDE_NAMES = new Set(['.git', 'node_modules', '.env']);

export function isVerificationProfile(
  value: unknown,
): value is VerificationProfile {
  return (
    typeof value === 'string' &&
    VERIFICATION_PROFILES.includes(value as VerificationProfile)
  );
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
      if (SNAPSHOT_EXCLUDE_NAMES.has(entry)) continue;
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

export function computeVerificationSnapshotId(repoDir: string): string {
  const hash = createHash('sha256');
  updateSnapshotHash(hash, repoDir, repoDir);
  return `fs:${hash.digest('hex').slice(0, 24)}`;
}

export function resolveVerificationResponsesDir(hostIpcDir: string): string {
  return path.join(hostIpcDir, 'verification-responses');
}

export async function waitForVerificationResponse(
  responseDir: string,
  requestId: string,
  options?: {
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<VerificationResponse> {
  const timeoutMs = options?.timeoutMs ?? 20 * 60 * 1000;
  const pollMs = options?.pollMs ?? 100;
  const responsePath = path.join(responseDir, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (fs.existsSync(responsePath)) {
      const response = JSON.parse(
        fs.readFileSync(responsePath, 'utf-8'),
      ) as VerificationResponse;
      fs.unlinkSync(responsePath);
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Timed out waiting for verification response: ${requestId}`,
  );
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
