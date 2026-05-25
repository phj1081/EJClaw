import { execFile } from 'child_process';

export const REPO_EVIDENCE_ACTIONS = [
  'git_status',
  'git_head',
  'git_recent_log',
  'git_show_ref',
] as const;

export type RepoEvidenceAction = (typeof REPO_EVIDENCE_ACTIONS)[number];

export interface RepoEvidenceRequest {
  action: RepoEvidenceAction;
  ref?: string;
  limit?: number;
}

export interface RepoEvidenceResponse {
  ok: boolean;
  action: RepoEvidenceAction;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  workdir: string;
  error?: string;
}

interface RepoEvidenceCommandSpec {
  file: string;
  args: string[];
  commandText: string;
}

const DEFAULT_LOG_LIMIT = 10;
const MAX_LOG_LIMIT = 30;
const MAX_OUTPUT_CHARS = 16_000;
const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER = 1024 * 1024;
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._/@:{}~^+-]{1,160}$/;

export function normalizeRepoEvidenceLimit(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LOG_LIMIT;
  }
  const normalized = Math.trunc(value as number);
  return Math.min(Math.max(normalized, 1), MAX_LOG_LIMIT);
}

export function normalizeRepoEvidenceRef(value?: string): string {
  const ref = value?.trim() || 'HEAD';
  if (
    ref.startsWith('-') ||
    ref.includes('..') ||
    !SAFE_GIT_REF_PATTERN.test(ref)
  ) {
    throw new Error(`Unsupported git ref for read-only evidence: ${ref}`);
  }
  return ref;
}

export function buildRepoEvidenceCommand(
  repoRoot: string,
  request: RepoEvidenceRequest,
): RepoEvidenceCommandSpec {
  const gitArgs = ['-C', repoRoot];
  switch (request.action) {
    case 'git_status': {
      const args = [...gitArgs, 'status', '--short', '--branch'];
      return {
        file: 'git',
        args,
        commandText: `git ${args.join(' ')}`,
      };
    }
    case 'git_head': {
      const args = [...gitArgs, 'log', '-1', '--oneline', '--decorate'];
      return {
        file: 'git',
        args,
        commandText: `git ${args.join(' ')}`,
      };
    }
    case 'git_recent_log': {
      const limit = normalizeRepoEvidenceLimit(request.limit);
      const args = [...gitArgs, 'log', `-${limit}`, '--oneline', '--decorate'];
      return {
        file: 'git',
        args,
        commandText: `git ${args.join(' ')}`,
      };
    }
    case 'git_show_ref': {
      const ref = normalizeRepoEvidenceRef(request.ref);
      const args = [
        ...gitArgs,
        'show',
        '--stat',
        '--oneline',
        '--decorate',
        '--no-ext-diff',
        '--no-renames',
        ref,
      ];
      return {
        file: 'git',
        args,
        commandText: `git ${args.join(' ')}`,
      };
    }
  }
}

function truncateRepoEvidenceText(value: string | undefined): string {
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

export async function runRepoEvidenceRequestDirect(
  repoRoot: string,
  request: RepoEvidenceRequest,
): Promise<RepoEvidenceResponse> {
  let command: RepoEvidenceCommandSpec;
  try {
    command = buildRepoEvidenceCommand(repoRoot, request);
  } catch (error) {
    return {
      ok: false,
      action: request.action,
      command: '',
      stdout: '',
      stderr: '',
      exitCode: 1,
      workdir: repoRoot,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const { stdout, stderr } = await execFileCapture(
      command.file,
      command.args,
    );
    return {
      ok: true,
      action: request.action,
      command: command.commandText,
      stdout: truncateRepoEvidenceText(stdout),
      stderr: truncateRepoEvidenceText(stderr),
      exitCode: 0,
      workdir: repoRoot,
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
      stdout: truncateRepoEvidenceText(stdout),
      stderr: truncateRepoEvidenceText(stderr),
      exitCode: extractExitCode(error),
      workdir: repoRoot,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatRepoEvidenceResponse(
  response: RepoEvidenceResponse,
): string {
  const parts = [
    `Repo evidence action: ${response.action}`,
    `Workdir: ${response.workdir}`,
    `Exit code: ${response.exitCode}`,
    response.command ? `$ ${response.command}` : null,
    response.stdout ? response.stdout.trimEnd() : null,
    response.stderr ? `[stderr]\n${response.stderr.trimEnd()}` : null,
    response.error ? `[error] ${response.error}` : null,
  ].filter((value): value is string => Boolean(value));

  return parts.join('\n');
}
