import { execFile } from 'child_process';

import { extractWatchCiTarget } from './task-watch-status.js';
import type { ScheduledTask } from './types.js';

export interface GitHubCiMetadata {
  repo: string;
  run_id: number;
  poll_count?: number;
  consecutive_errors?: number;
  last_checked_at?: string;
}

interface GitHubActionsRunResponse {
  status?: string | null;
  conclusion?: string | null;
  name?: string | null;
  display_title?: string | null;
  html_url?: string | null;
  head_branch?: string | null;
  head_sha?: string | null;
  event?: string | null;
}

interface GitHubActionsJobsResponse {
  jobs?: Array<{
    name?: string | null;
    conclusion?: string | null;
  }>;
}

export interface GitHubRunCheckResult {
  terminal: boolean;
  resultSummary: string;
  completionMessage?: string;
}

export const MAX_GITHUB_CONSECUTIVE_ERRORS = 5;
export const GITHUB_WATCH_BACKOFF_STEPS = [
  { afterMs: 60 * 60 * 1000, delayMs: 60_000 },
  { afterMs: 10 * 60 * 1000, delayMs: 30_000 },
] as const;

function execGhApi(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['api', ...args],
      {
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = stderr?.trim() || stdout?.trim() || error.message;
          reject(new Error(`gh api failed: ${details}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function parseGitHubCiMetadata(
  raw: string | null | undefined,
): GitHubCiMetadata | null {
  if (!raw) return null;

  let parsed: Partial<GitHubCiMetadata>;
  try {
    parsed = JSON.parse(raw) as Partial<GitHubCiMetadata>;
  } catch {
    return null;
  }
  if (typeof parsed.repo !== 'string' || parsed.repo.trim() === '') {
    return null;
  }

  const runId = Number(parsed.run_id);
  if (!Number.isInteger(runId) || runId <= 0) {
    return null;
  }

  return {
    repo: parsed.repo,
    run_id: runId,
    poll_count:
      Number.isInteger(parsed.poll_count) && parsed.poll_count! >= 0
        ? parsed.poll_count
        : undefined,
    consecutive_errors:
      Number.isInteger(parsed.consecutive_errors) &&
      parsed.consecutive_errors! >= 0
        ? parsed.consecutive_errors
        : undefined,
    last_checked_at:
      typeof parsed.last_checked_at === 'string' &&
      parsed.last_checked_at.trim() !== ''
        ? parsed.last_checked_at
        : undefined,
  };
}

export function serializeGitHubCiMetadata(metadata: GitHubCiMetadata): string {
  return JSON.stringify(metadata);
}

export function computeGitHubWatcherDelayMs(
  task: Pick<ScheduledTask, 'schedule_value' | 'created_at'>,
  nowMs: number,
): number {
  const baseDelayMs = Number.parseInt(task.schedule_value, 10);
  const normalizedBaseDelayMs =
    Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 15_000;

  const createdAtMs = new Date(task.created_at).getTime();
  const elapsedMs = Number.isFinite(createdAtMs)
    ? Math.max(0, nowMs - createdAtMs)
    : 0;

  for (const step of GITHUB_WATCH_BACKOFF_STEPS) {
    if (elapsedMs >= step.afterMs) {
      return Math.max(normalizedBaseDelayMs, step.delayMs);
    }
  }

  return normalizedBaseDelayMs;
}

function formatConclusionLabel(conclusion: string | null | undefined): string {
  switch (conclusion) {
    case 'success':
      return '성공';
    case 'failure':
      return '실패';
    case 'cancelled':
      return '취소됨';
    case 'timed_out':
      return '시간 초과';
    case 'action_required':
      return '조치 필요';
    case 'neutral':
      return '중립';
    case 'skipped':
      return '건너뜀';
    case 'stale':
      return '오래됨';
    default:
      return conclusion || '완료';
  }
}

async function fetchFailedJobs(metadata: GitHubCiMetadata): Promise<string[]> {
  const stdout = await execGhApi([
    `repos/${metadata.repo}/actions/runs/${metadata.run_id}/jobs?per_page=100`,
  ]);
  const parsed = JSON.parse(stdout) as GitHubActionsJobsResponse;
  return (parsed.jobs || [])
    .filter(
      (job) =>
        job.conclusion &&
        ['failure', 'cancelled', 'timed_out', 'startup_failure'].includes(
          job.conclusion,
        ),
    )
    .map((job) => job.name?.trim())
    .filter((name): name is string => Boolean(name))
    .slice(0, 3);
}

export async function checkGitHubActionsRun(
  task: Pick<ScheduledTask, 'prompt' | 'ci_metadata'>,
): Promise<GitHubRunCheckResult> {
  const metadata = parseGitHubCiMetadata(task.ci_metadata);
  if (!metadata) {
    throw new Error('Task is missing valid GitHub CI metadata');
  }

  const stdout = await execGhApi([
    `repos/${metadata.repo}/actions/runs/${metadata.run_id}`,
  ]);
  const run = JSON.parse(stdout) as GitHubActionsRunResponse;
  const status = run.status || 'unknown';

  if (status !== 'completed') {
    return {
      terminal: false,
      resultSummary: `GitHub Actions run ${metadata.run_id} is ${status}`,
    };
  }

  let failedJobs: string[] = [];
  try {
    failedJobs = await fetchFailedJobs(metadata);
  } catch {
    failedJobs = [];
  }

  const target =
    extractWatchCiTarget(task.prompt) ||
    `GitHub Actions run ${metadata.run_id}`;
  const conclusionLabel = formatConclusionLabel(run.conclusion);

  const lines = [
    `CI 완료: ${target}`,
    `판정: ${conclusionLabel}`,
    `- 저장소: ${metadata.repo}`,
  ];

  if (run.name) {
    lines.push(`- 워크플로: ${run.name}`);
  }
  if (run.head_branch) {
    lines.push(`- 브랜치: ${run.head_branch}`);
  }
  if (failedJobs.length > 0) {
    lines.push(`- 실패 job: ${failedJobs.join(', ')}`);
  }
  if (run.html_url) {
    lines.push(`- 링크: ${run.html_url}`);
  }

  return {
    terminal: true,
    resultSummary: `${conclusionLabel}: ${metadata.repo} run ${metadata.run_id}`,
    completionMessage: lines.join('\n'),
  };
}
