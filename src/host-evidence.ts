import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from './group-folder.js';

export const HOST_EVIDENCE_ACTIONS = [
  'ejclaw_service_status',
  'ejclaw_service_logs',
] as const;

export type HostEvidenceAction = (typeof HOST_EVIDENCE_ACTIONS)[number];

export interface HostEvidenceRequest {
  requestId: string;
  action: HostEvidenceAction;
  tailLines?: number;
}

export interface HostEvidenceResult {
  ok: boolean;
  action: HostEvidenceAction | 'ejclaw_room_runtime';
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export interface HostEvidenceResponse extends HostEvidenceResult {
  requestId: string;
}

interface HostEvidenceCommandSpec {
  file: string;
  args: string[];
  commandText: string;
}

const DEFAULT_LOG_TAIL_LINES = 20;
const MAX_LOG_TAIL_LINES = 200;
const MAX_OUTPUT_CHARS = 16_000;
const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER = 1024 * 1024;

export function isHostEvidenceAction(
  value: unknown,
): value is HostEvidenceAction {
  return (
    typeof value === 'string' &&
    HOST_EVIDENCE_ACTIONS.includes(value as HostEvidenceAction)
  );
}

export function clampHostEvidenceTailLines(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LOG_TAIL_LINES;
  }
  const normalized = Math.trunc(value as number);
  return Math.min(Math.max(normalized, 1), MAX_LOG_TAIL_LINES);
}

export function buildHostEvidenceCommand(
  request: HostEvidenceRequest,
): HostEvidenceCommandSpec {
  switch (request.action) {
    case 'ejclaw_service_status': {
      const args = [
        '--user',
        'show',
        'ejclaw',
        '-p',
        'Id',
        '-p',
        'LoadState',
        '-p',
        'ActiveState',
        '-p',
        'SubState',
        '-p',
        'ExecMainCode',
        '-p',
        'ExecMainStatus',
        '-p',
        'ExecMainStartTimestamp',
        '-p',
        'ActiveEnterTimestamp',
      ];
      return {
        file: 'systemctl',
        args,
        commandText: `systemctl ${args.join(' ')}`,
      };
    }
    case 'ejclaw_service_logs': {
      const tailLines = clampHostEvidenceTailLines(request.tailLines);
      const args = [
        '--user',
        '-u',
        'ejclaw',
        '--no-pager',
        '-n',
        String(tailLines),
      ];
      return {
        file: 'journalctl',
        args,
        commandText: `journalctl ${args.join(' ')}`,
      };
    }
  }
}

export function truncateHostEvidenceText(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
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
        resolve({
          stdout,
          stderr,
        });
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

export async function runHostEvidenceRequest(
  request: HostEvidenceRequest,
): Promise<HostEvidenceResult> {
  const command = buildHostEvidenceCommand(request);

  try {
    const { stdout, stderr } = await execFileCapture(
      command.file,
      command.args,
    );
    return {
      ok: true,
      action: request.action,
      command: command.commandText,
      stdout: truncateHostEvidenceText(stdout),
      stderr: truncateHostEvidenceText(stderr),
      exitCode: 0,
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
      action: request.action,
      command: command.commandText,
      stdout: truncateHostEvidenceText(stdout),
      stderr: truncateHostEvidenceText(stderr),
      exitCode: extractExitCode(error),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveHostEvidenceResponseDir(groupFolder: string): string {
  return path.join(resolveGroupIpcPath(groupFolder), 'host-evidence-responses');
}

export function writeHostEvidenceResponse(
  groupFolder: string,
  response: HostEvidenceResponse,
): string {
  const responseDir = resolveHostEvidenceResponseDir(groupFolder);
  fs.mkdirSync(responseDir, { recursive: true });

  const outputPath = path.join(responseDir, `${response.requestId}.json`);
  const tempPath = `${outputPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(response, null, 2));
  fs.renameSync(tempPath, outputPath);
  return outputPath;
}
