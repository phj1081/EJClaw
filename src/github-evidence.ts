import { execFile } from 'child_process';
import {
  GITHUB_EVIDENCE_ACTIONS,
  isGitHubEvidenceAction,
  type GitHubEvidenceAction,
} from 'ejclaw-runners-shared';

export {
  GITHUB_EVIDENCE_ACTIONS,
  isGitHubEvidenceAction,
  type GitHubEvidenceAction,
};

export interface GitHubEvidenceRequest {
  action: GitHubEvidenceAction;
  repo?: string;
  prNumber?: number;
  runId?: number;
  workflowPath?: string;
  ref?: string;
}

interface GitHubCommandSpec {
  file: string;
  args: string[];
  commandText: string;
  decodeBase64Stdout?: boolean;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_MAX_BUFFER = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 24_000;

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

export function normalizeGitHubWorkflowPath(value?: string): string {
  const workflowPath = value?.trim();
  if (!workflowPath || !WORKFLOW_PATH_PATTERN.test(workflowPath)) {
    throw new Error(`Unsupported GitHub workflow path for evidence: ${value}`);
  }
  return workflowPath;
}

export function normalizeGitHubRef(value?: string): string {
  const ref = value?.trim();
  if (
    !ref ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.endsWith('/') ||
    !REF_PATTERN.test(ref)
  ) {
    throw new Error(`Missing or invalid ref for GitHub evidence`);
  }
  return ref;
}

export function decodeGitHubContentBase64(value: string): string {
  return Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8');
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
    case 'github_run_jobs': {
      const runId = normalizePositiveInteger(request.runId, 'run_id');
      const args = [
        'run',
        'view',
        String(runId),
        '--repo',
        repo,
        '--json',
        'databaseId,name,status,conclusion,url,headBranch,headSha,jobs',
      ];
      return {
        file: 'gh',
        args,
        commandText: `gh ${args.join(' ')}`,
      };
    }
    case 'github_workflow_file': {
      const workflowPath = normalizeGitHubWorkflowPath(request.workflowPath);
      const ref = normalizeGitHubRef(request.ref);
      const endpoint = `repos/${repo}/contents/${workflowPath}?ref=${encodeURIComponent(ref)}`;
      const args = ['api', endpoint, '--jq', '.content'];
      return {
        file: 'gh',
        args,
        commandText: `gh ${args.join(' ')}`,
        decodeBase64Stdout: true,
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
        const normalizedStdout = command.decodeBase64Stdout
          ? decodeGitHubContentBase64(stdout)
          : stdout;
        resolve({
          command: command.commandText,
          stdout: truncateGitHubEvidenceText(normalizedStdout),
          stderr: truncateGitHubEvidenceText(stderr),
        });
      },
    );
  });
}
