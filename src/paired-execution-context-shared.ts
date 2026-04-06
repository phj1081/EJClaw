import { execFileSync } from 'child_process';

import { isArbiterEnabled } from './config.js';
import { updatePairedTask } from './db.js';
import { logger } from './logger.js';

export type Verdict =
  | 'done'
  | 'done_with_concerns'
  | 'blocked'
  | 'needs_context'
  | 'continue';

export function classifyVerdict(summary: string | null | undefined): Verdict {
  if (!summary) return 'continue';
  const cleaned = summary.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
  if (!cleaned) return 'continue';
  const firstLine = cleaned.split('\n')[0].trim();
  if (/^\*{0,2}BLOCKED\*{0,2}\b/i.test(firstLine)) return 'blocked';
  if (/^\*{0,2}NEEDS_CONTEXT\*{0,2}\b/i.test(firstLine)) return 'needs_context';
  if (/^\*{0,2}DONE_WITH_CONCERNS\*{0,2}\b/i.test(firstLine))
    return 'done_with_concerns';
  if (/^\*{0,2}DONE\*{0,2}\b/i.test(firstLine)) return 'done';
  if (/^\*{0,2}Approved\.?\*{0,2}/i.test(firstLine)) return 'done';
  if (/^\*{0,2}LGTM\*{0,2}/i.test(firstLine)) return 'done';
  return 'continue';
}

export type ArbiterVerdictResult =
  | 'proceed'
  | 'revise'
  | 'reset'
  | 'escalate'
  | 'unknown';

export function classifyArbiterVerdict(
  summary: string | null | undefined,
): ArbiterVerdictResult {
  if (!summary) return 'unknown';
  const cleaned = summary.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
  if (!cleaned) return 'unknown';
  const firstLine = cleaned.split('\n')[0].trim();
  const verdictMatch = firstLine.match(
    /\*{0,2}(?:VERDICT\s*[:—-]\s*)?(PROCEED|REVISE|RESET|ESCALATE)\*{0,2}/i,
  );
  if (verdictMatch) {
    return verdictMatch[1].toLowerCase() as ArbiterVerdictResult;
  }
  return 'unknown';
}

export function resolveCanonicalSourceRef(workDir: string): string {
  const treeHash = resolveCanonicalTreeHash(workDir);
  return treeHash || 'HEAD';
}

function resolveCanonicalTreeHash(workDir: string): string | null {
  try {
    const treeHash = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return treeHash || null;
  } catch {
    return null;
  }
}

export function hasCodeChangesSinceRef(
  workDir: string,
  sourceRef: string | null | undefined,
): boolean | null {
  if (!sourceRef) return null;
  try {
    execFileSync('git', ['diff', '--quiet', sourceRef, 'HEAD'], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return false;
  } catch (error) {
    const exitCode =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : null;
    if (exitCode === 1) {
      return true;
    }
    return null;
  }
}

export function requestArbiterOrEscalate(args: {
  taskId: string;
  now: string;
  arbiterLogMessage: string;
  escalateLogMessage: string;
  logContext?: Record<string, unknown>;
}): void {
  const { taskId, now, arbiterLogMessage, escalateLogMessage, logContext } =
    args;
  if (isArbiterEnabled()) {
    updatePairedTask(taskId, {
      status: 'arbiter_requested',
      arbiter_requested_at: now,
      updated_at: now,
    });
    logger.info(logContext ?? { taskId }, arbiterLogMessage);
    return;
  }

  updatePairedTask(taskId, {
    status: 'completed',
    completion_reason: 'escalated',
    updated_at: now,
  });
  logger.info(logContext ?? { taskId }, escalateLogMessage);
}
