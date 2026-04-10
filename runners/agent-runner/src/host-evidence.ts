import fs from 'fs';
import path from 'path';

export const HOST_EVIDENCE_ACTIONS = [
  'ejclaw_service_status',
  'ejclaw_service_logs',
] as const;

export type HostEvidenceAction = (typeof HOST_EVIDENCE_ACTIONS)[number];

export interface HostEvidenceResponse {
  requestId: string;
  ok: boolean;
  action: HostEvidenceAction;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

const DEFAULT_LOG_TAIL_LINES = 20;
const MAX_LOG_TAIL_LINES = 200;

export function normalizeHostEvidenceTailLines(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LOG_TAIL_LINES;
  }
  const normalized = Math.trunc(value as number);
  return Math.min(Math.max(normalized, 1), MAX_LOG_TAIL_LINES);
}

export function resolveHostEvidenceResponsesDir(hostIpcDir: string): string {
  return path.join(hostIpcDir, 'host-evidence-responses');
}

export async function waitForHostEvidenceResponse(
  responseDir: string,
  requestId: string,
  options?: {
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<HostEvidenceResponse> {
  const timeoutMs = options?.timeoutMs ?? 7_000;
  const pollMs = options?.pollMs ?? 100;
  const responsePath = path.join(responseDir, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (fs.existsSync(responsePath)) {
      const response = JSON.parse(
        fs.readFileSync(responsePath, 'utf-8'),
      ) as HostEvidenceResponse;
      fs.unlinkSync(responsePath);
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`Timed out waiting for host evidence response: ${requestId}`);
}

export function formatHostEvidenceResponse(
  response: HostEvidenceResponse,
): string {
  const parts = [
    `Host evidence action: ${response.action}`,
    `Exit code: ${response.exitCode}`,
    response.command ? `$ ${response.command}` : null,
    response.stdout ? response.stdout.trimEnd() : null,
    response.stderr ? `[stderr]\n${response.stderr.trimEnd()}` : null,
    response.error ? `[error] ${response.error}` : null,
  ].filter((value): value is string => Boolean(value));

  return parts.join('\n');
}
