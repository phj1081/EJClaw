import { execFile } from 'child_process';

export const GITHUB_EVIDENCE_ACTIONS = [
  'github_pr_status',
  'github_pr_diff_stat',
  'github_run_status',
] as const;

export type GitHubEvidenceAction = (typeof GITHUB_EVIDENCE_ACTIONS)[number];

export interface GitHubEvidenceRequest {
  action: GitHubEvidenceAction;
  repo?: string;
  prNumber?: number;
  runId?: number;
}

interface GitHubCommandSpec {
  file: string;
  args: string[];
  commandText: string;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_MAX_BUFFER = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 24_000;

export function isGitHubEvidenceAction(
  value: unknown,
): value is GitHubEvidenceAction {
  return (
    typeof value === 'string' &&
    GITHUB_EVIDENCE_ACTIONS.includes(value as GitHubEvidenceAction)
  );
}

export function normalizeGitHubRepo(value?: string): string {
  const repo = value?.trim();
  if (!repo || repo.includes('..') || !REPO_PATTERN.test(repo)) {
    throw new Error(`Unsupported GitHub repo for evidence: ${value}`);
  }
  return repo;
}

export function normalizePositiveInteger(
  value: number | undefined,
  label: string,
): number {
  if (value == null || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Missing or invalid ${label} for GitHub evidence`);
  }
  return value;
}

export function buildGitHubEvidenceCommand(
  request: GitHubEvidenceRequest,
): GitHubCommandSpec {
  const repo = normalizeGitHubRepo(request.repo);

  switch (request.action) {
    case 'github_pr_status': {
      const prNumber = normalizePositiveInteger(request.prNumber, 'pr_number');
      const args = [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        repo,
        '--json',
        'number,title,state,mergeStateStatus,headRefName,baseRefName,headRefOid,url,statusCheckRollup',
      ];
      return {
        file: 'gh',
        args,
        commandText: `gh ${args.join(' ')}`,
      };
    }
    case 'github_pr_diff_stat': {
      const prNumber = normalizePositiveInteger(request.prNumber, 'pr_number');
      const args = ['pr', 'diff', String(prNumber), '--repo', repo, '--stat'];
      return {
        file: 'gh',
        args,
        commandText: `gh ${args.join(' ')}`,
      };
    }
    case 'github_run_status': {
      const runId = normalizePositiveInteger(request.runId, 'run_id');
      const args = [
        'run',
        'view',
        String(runId),
        '--repo',
        repo,
        '--json',
        'status,conclusion,name,displayTitle,url,headBranch,headSha,event,createdAt,updatedAt',
      ];
      return {
        file: 'gh',
        args,
        commandText: `gh ${args.join(' ')}`,
      };
    }
  }
}

function truncateGitHubEvidenceText(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
}

export function runGitHubEvidenceCommand(
  request: GitHubEvidenceRequest,
): Promise<{
  command: string;
  stdout: string;
  stderr: string;
}> {
  const command = buildGitHubEvidenceCommand(request);
  return new Promise((resolve, reject) => {
    execFile(
      command.file,
      command.args,
      {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(error, {
              command: command.commandText,
              stdout: truncateGitHubEvidenceText(stdout),
              stderr: truncateGitHubEvidenceText(stderr),
            }),
          );
          return;
        }
        resolve({
          command: command.commandText,
          stdout: truncateGitHubEvidenceText(stdout),
          stderr: truncateGitHubEvidenceText(stderr),
        });
      },
    );
  });
}
