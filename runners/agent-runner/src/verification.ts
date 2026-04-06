import fs from 'fs';
import path from 'path';
export {
  computeVerificationSnapshotId,
  resolveVerificationResponsesDir,
} from '../../../shared/verification-snapshot.js';

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

export function isVerificationProfile(
  value: unknown,
): value is VerificationProfile {
  return (
    typeof value === 'string' &&
    VERIFICATION_PROFILES.includes(value as VerificationProfile)
  );
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
