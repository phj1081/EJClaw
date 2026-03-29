import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, PAIRED_MAX_ROUND_TRIPS } from './config.js';
import {
  createPairedTask,
  getLatestPairedTaskForChat,
  getLatestOpenPairedTaskForChat,
  getPairedTaskById,
  getPairedWorkspace,
  updatePairedTask,
  upsertPairedProject,
} from './db.js';
import { logger } from './logger.js';
import {
  markPairedTaskReviewReady,
  prepareReviewerWorkspaceForExecution,
  provisionOwnerWorkspaceForPairedTask,
} from './paired-workspace-manager.js';
import type {
  PairedTask,
  PairedWorkspace,
  RegisteredGroup,
  RoomRoleContext,
} from './types.js';

// ---------------------------------------------------------------------------
// Reviewer verdict detection
// ---------------------------------------------------------------------------

type ReviewerVerdict =
  | 'done'
  | 'done_with_concerns'
  | 'blocked'
  | 'needs_context'
  | 'continue';

function classifyReviewerVerdict(
  summary: string | null | undefined,
): ReviewerVerdict {
  if (!summary) return 'continue';
  // Strip <internal>...</internal> tags — these are internal reasoning, not the verdict
  const cleaned = summary.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
  if (!cleaned) return 'continue';
  const firstLine = cleaned.split('\n')[0].trim();
  // Match verdict markers at the start of the first visible line
  if (/^\*{0,2}BLOCKED\*{0,2}\b/i.test(firstLine)) return 'blocked';
  if (/^\*{0,2}NEEDS_CONTEXT\*{0,2}\b/i.test(firstLine)) return 'needs_context';
  if (/^\*{0,2}DONE_WITH_CONCERNS\*{0,2}\b/i.test(firstLine))
    return 'done_with_concerns';
  if (/^\*{0,2}DONE\*{0,2}\b/i.test(firstLine)) return 'done';
  if (/^\*{0,2}Approved\.?\*{0,2}/i.test(firstLine)) return 'done';
  if (/^\*{0,2}LGTM\*{0,2}/i.test(firstLine)) return 'done';
  return 'continue';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveCanonicalSourceRef(workDir: string): string {
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

function hasCodeChangesSinceRef(
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

function ensurePairedProject(
  group: RegisteredGroup,
  chatJid: string,
): string | null {
  if (!group.workDir) {
    return null;
  }

  const now = new Date().toISOString();
  upsertPairedProject({
    chat_jid: chatJid,
    group_folder: group.folder,
    canonical_work_dir: group.workDir,
    created_at: now,
    updated_at: now,
  });
  return group.workDir;
}

// ---------------------------------------------------------------------------
// ensureActiveTask
// ---------------------------------------------------------------------------

function ensureActiveTask(
  group: RegisteredGroup,
  chatJid: string,
  roomRoleContext: RoomRoleContext,
): PairedTask | null {
  const canonicalWorkDir = ensurePairedProject(group, chatJid);
  if (!canonicalWorkDir) {
    return null;
  }

  const existing = getLatestOpenPairedTaskForChat(chatJid);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const task: PairedTask = {
    id: crypto.randomUUID(),
    chat_jid: chatJid,
    group_folder: group.folder,
    owner_service_id: roomRoleContext.ownerServiceId,
    reviewer_service_id: roomRoleContext.reviewerServiceId,
    title: null,
    source_ref: resolveCanonicalSourceRef(canonicalWorkDir),
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 0,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  createPairedTask(task);
  logger.info(
    {
      chatJid,
      groupFolder: group.folder,
      taskId: task.id,
      sourceRef: task.source_ref,
    },
    'Created active paired task for room',
  );
  return task;
}

// ---------------------------------------------------------------------------
// preparePairedExecutionContext
// ---------------------------------------------------------------------------

export interface PreparedPairedExecutionContext {
  task: PairedTask;
  workspace: PairedWorkspace | null;
  envOverrides: Record<string, string>;
  gateTurnKind?: string | null;
  requiresVisibleVerdict?: boolean;
  blockMessage?: string;
}

export interface PairedExecutionRecoveryPlan {
  task: PairedTask;
  role: RoomRoleContext['role'];
  checkpointFingerprint: string | null;
  recoveryKey: string;
  prompt: string;
}

export function preparePairedExecutionContext(args: {
  group: RegisteredGroup;
  chatJid: string;
  runId: string;
  roomRoleContext?: RoomRoleContext;
}): PreparedPairedExecutionContext | undefined {
  const { group, chatJid, roomRoleContext } = args;
  if (!roomRoleContext || !group.workDir) {
    return undefined;
  }

  const task = ensureActiveTask(group, chatJid, roomRoleContext);
  if (!task) {
    return undefined;
  }

  const latestTask = getPairedTaskById(task.id) ?? task;
  let workspace: PairedWorkspace | null = null;
  let blockMessage: string | undefined;
  const now = new Date().toISOString();

  if (roomRoleContext.role === 'owner') {
    // New human message → new ping-pong cycle. Reset the round trip counter
    // so previous interactions don't block the auto-review trigger.
    if (latestTask.round_trip_count > 0) {
      updatePairedTask(latestTask.id, {
        round_trip_count: 0,
        updated_at: now,
      });
    }
    // Use a stable per-channel worktree (not per-task) so the Claude SDK
    // session persists across tasks. Different channels still get isolation.
    workspace = provisionOwnerWorkspaceForPairedTask(latestTask.id);
  } else {
    const reviewerWorkspace = prepareReviewerWorkspaceForExecution(latestTask);
    workspace = reviewerWorkspace.workspace;
    blockMessage = reviewerWorkspace.blockMessage;
    const refreshedTask = getPairedTaskById(latestTask.id) ?? latestTask;
    if (workspace && refreshedTask.status === 'review_ready') {
      updatePairedTask(latestTask.id, {
        status: 'in_review',
        updated_at: now,
      });
    }
  }

  const envOverrides: Record<string, string> = {
    EJCLAW_PAIRED_TASK_ID: task.id,
    EJCLAW_PAIRED_ROLE: roomRoleContext.role,
  };

  if (workspace?.workspace_dir) {
    envOverrides.EJCLAW_WORK_DIR = workspace.workspace_dir;
  }
  if (roomRoleContext.role === 'reviewer') {
    envOverrides.EJCLAW_REVIEWER_RUNTIME = '1';
    // Use a separate Claude config dir so the reviewer's SDK session cache
    // doesn't collide with the owner's. Without this, the Claude SDK picks
    // up the owner's cached session from disk even when sessionId is undefined.
    const reviewerSessionDir = path.join(
      DATA_DIR,
      'sessions',
      `${group.folder}-reviewer`,
    );
    fs.mkdirSync(reviewerSessionDir, { recursive: true });
    envOverrides.CLAUDE_CONFIG_DIR = reviewerSessionDir;
  }

  return {
    task: getPairedTaskById(task.id) ?? task,
    workspace,
    envOverrides,
    blockMessage,
  };
}

// ---------------------------------------------------------------------------
// completePairedExecutionContext
// ---------------------------------------------------------------------------

export function completePairedExecutionContext(args: {
  taskId: string;
  role: 'owner' | 'reviewer';
  status: 'succeeded' | 'failed';
  summary?: string | null;
}): void {
  const { taskId, role, status } = args;
  logger.info(
    {
      taskId,
      role,
      status,
      summary: args.summary?.slice(0, 200),
    },
    'Paired execution completed',
  );

  const task = getPairedTaskById(taskId);
  if (!task) return;

  // On failure: for reviewers, still check verdict from summary — output may
  // have been delivered even though the executor classified it as failed
  // (e.g. intermediate buffer → null result). This prevents infinite loops.
  if (status !== 'succeeded') {
    if (role === 'reviewer' && args.summary) {
      const verdict = classifyReviewerVerdict(args.summary);
      if (
        verdict === 'done' ||
        verdict === 'blocked' ||
        verdict === 'needs_context'
      ) {
        const now = new Date().toISOString();
        const ownerWs =
          verdict === 'done' ? getPairedWorkspace(taskId, 'owner') : null;
        const approvedSourceRef =
          verdict === 'done' && ownerWs?.workspace_dir
            ? resolveCanonicalSourceRef(ownerWs.workspace_dir)
            : task.source_ref;
        updatePairedTask(taskId, {
          status: verdict === 'done' ? 'merge_ready' : 'completed',
          ...(verdict === 'done' ? { source_ref: approvedSourceRef } : {}),
          updated_at: now,
        });
        logger.info(
          {
            taskId,
            verdict,
            approvedSourceRef,
            summary: args.summary?.slice(0, 100),
          },
          'Reviewer verdict detected from failed execution — stopping ping-pong',
        );
        return;
      }
    }
    if (task.status !== 'active') {
      const now = new Date().toISOString();
      updatePairedTask(taskId, { status: 'active', updated_at: now });
      logger.info(
        { taskId, role, previousStatus: task.status },
        'Reset task to active after failed execution',
      );
    }
    return;
  }

  // Owner finished
  if (role === 'owner') {
    const now = new Date().toISOString();

    // merge_ready → reviewer already approved. Check owner verdict and
    // whether owner made additional changes that need re-review.
    if (task.status === 'merge_ready') {
      // Owner can raise concerns even during finalize (e.g. push failed,
      // detached HEAD, discovered issue). Respect the owner's verdict.
      const ownerVerdict = classifyReviewerVerdict(args.summary);
      if (
        ownerVerdict === 'done_with_concerns' ||
        ownerVerdict === 'blocked' ||
        ownerVerdict === 'needs_context'
      ) {
        updatePairedTask(taskId, { status: 'active', updated_at: now });
        logger.info(
          {
            taskId,
            ownerVerdict,
            summary: args.summary?.slice(0, 100),
          },
          'Owner raised concerns during finalize — task set back to active',
        );
        // Fall through to auto-trigger reviewer for the new concern
      } else {
        const workspace = getPairedWorkspace(task.id, 'owner');
        const hasNewChanges = workspace?.workspace_dir
          ? hasCodeChangesSinceRef(workspace.workspace_dir, task.source_ref)
          : null;

        if (hasNewChanges === false) {
          // No code changes since reviewer approved → finalize complete
          updatePairedTask(taskId, { status: 'completed', updated_at: now });
          logger.info(
            { taskId, summary: args.summary?.slice(0, 100) },
            'Owner finalized after reviewer approval — task completed',
          );
          return;
        }
        // Owner made changes after approval → needs re-review
        logger.info(
          {
            taskId,
            sourceRef: task.source_ref,
            hasNewChanges,
          },
          'Owner made changes after reviewer approval — re-triggering review',
        );
      }
    }

    // Normal turn → auto-trigger reviewer (if within round trip limit)
    if (task.round_trip_count >= PAIRED_MAX_ROUND_TRIPS) {
      logger.info(
        {
          taskId,
          roundTrips: task.round_trip_count,
          max: PAIRED_MAX_ROUND_TRIPS,
        },
        'Round trip limit reached, skipping auto-review',
      );
      return;
    }

    const result = markPairedTaskReviewReady(taskId);
    if (result) {
      updatePairedTask(taskId, {
        round_trip_count: task.round_trip_count + 1,
        review_requested_at: now,
        updated_at: now,
      });
      logger.info(
        { taskId, roundTrip: task.round_trip_count + 1 },
        'Auto-triggered reviewer after owner completion',
      );
    }
  }

  // Reviewer finished → classify verdict and route accordingly
  if (role === 'reviewer') {
    const now = new Date().toISOString();
    const verdict = classifyReviewerVerdict(args.summary);

    switch (verdict) {
      case 'done': {
        // Approved → owner gets final turn to commit/push.
        // Record the current HEAD as source_ref so the finalize turn
        // can detect if the owner made additional code changes.
        const ownerWs = getPairedWorkspace(taskId, 'owner');
        const approvedSourceRef = ownerWs?.workspace_dir
          ? resolveCanonicalSourceRef(ownerWs.workspace_dir)
          : task.source_ref;
        updatePairedTask(taskId, {
          status: 'merge_ready',
          source_ref: approvedSourceRef,
          updated_at: now,
        });
        logger.info(
          {
            taskId,
            verdict,
            approvedSourceRef,
            summary: args.summary?.slice(0, 100),
          },
          'Reviewer approved — owner gets final turn to finalize',
        );
        break;
      }

      case 'blocked':
      case 'needs_context':
        // Needs user decision — stop ping-pong, leave task active
        updatePairedTask(taskId, { status: 'completed', updated_at: now });
        logger.info(
          { taskId, verdict, summary: args.summary?.slice(0, 100) },
          'Reviewer escalated to user — ping-pong stopped',
        );
        break;

      case 'done_with_concerns':
      case 'continue':
      default:
        // Owner needs to address feedback — ping-pong continues
        updatePairedTask(taskId, { status: 'active', updated_at: now });
        logger.info(
          { taskId, verdict },
          'Reviewer has feedback, task set back to active for owner',
        );
        break;
    }
  }
}
