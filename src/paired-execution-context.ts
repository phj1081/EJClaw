import { execFileSync } from 'child_process';
import crypto from 'crypto';

import {
  SERVICE_ID,
  normalizeServiceId,
  PAIRED_MAX_ROUND_TRIPS,
} from './config.js';
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
// Helpers
// ---------------------------------------------------------------------------

function resolveCanonicalSourceRef(workDir: string): string {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return head || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

function resolveCanonicalHead(workDir: string): string | null {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return head || null;
  } catch {
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

  // On failure, reset task to active so the flow isn't stuck
  if (status !== 'succeeded') {
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

  // Owner finished → auto-trigger reviewer (if within round trip limit)
  if (role === 'owner') {
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

    const now = new Date().toISOString();
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

  // Reviewer finished → set task back to active so owner can respond
  if (role === 'reviewer') {
    const now = new Date().toISOString();
    updatePairedTask(taskId, {
      status: 'active',
      updated_at: now,
    });
    logger.info(
      { taskId },
      'Reviewer completed, task set back to active for owner',
    );
  }
}

// ---------------------------------------------------------------------------
// markRoomReviewReady
// ---------------------------------------------------------------------------

export type MarkRoomReviewReadyResult =
  | {
      status: 'ready';
      task: PairedTask;
      ownerWorkspace: PairedWorkspace;
      reviewerWorkspace: PairedWorkspace;
    }
  | {
      status: 'pending';
      task: PairedTask;
      pendingReason: 'owner-workspace-not-ready';
    }
  | null;

export function markRoomReviewReady(args: {
  group: RegisteredGroup;
  chatJid: string;
  roomRoleContext?: RoomRoleContext;
}): MarkRoomReviewReadyResult {
  const { group, chatJid, roomRoleContext } = args;
  if (!roomRoleContext || !group.workDir) {
    return null;
  }

  const task = ensureActiveTask(group, chatJid, roomRoleContext);
  if (!task) {
    return null;
  }

  const isOwnerService =
    normalizeServiceId(SERVICE_ID) === task.owner_service_id;
  const ownerWorkspace =
    (isOwnerService
      ? provisionOwnerWorkspaceForPairedTask(task.id)
      : getPairedWorkspace(task.id, 'owner')) ?? null;

  if (!ownerWorkspace) {
    markPairedTaskReviewReady(task.id);
    return {
      status: 'pending',
      task: getPairedTaskById(task.id) ?? task,
      pendingReason: 'owner-workspace-not-ready',
    };
  }

  // Update task status and refresh reviewer snapshot
  const reviewResult = markPairedTaskReviewReady(task.id);
  const latestTask = getPairedTaskById(task.id) ?? task;

  if (reviewResult) {
    return {
      status: 'ready',
      task: latestTask,
      ownerWorkspace: reviewResult.ownerWorkspace,
      reviewerWorkspace: reviewResult.reviewerWorkspace,
    };
  }

  // Snapshot refresh succeeded but result was null — try reading persisted state
  const reviewerWorkspace = getPairedWorkspace(task.id, 'reviewer');
  if (!reviewerWorkspace) {
    return {
      status: 'pending',
      task: latestTask,
      pendingReason: 'owner-workspace-not-ready',
    };
  }

  return {
    status: 'ready',
    task: latestTask,
    ownerWorkspace,
    reviewerWorkspace,
  };
}

// ---------------------------------------------------------------------------
// formatRoomReviewReadyMessage
// ---------------------------------------------------------------------------

export function formatRoomReviewReadyMessage(
  result: MarkRoomReviewReadyResult,
): string | null {
  if (!result) {
    return null;
  }

  if (result.status === 'pending') {
    return [
      'Review request recorded, but the owner workspace is not ready yet.',
      `- Task: ${result.task.id}`,
      'The task stays review_pending until the owner workspace is prepared.',
    ].join('\n');
  }

  return [
    'Review snapshot updated.',
    `- Task: ${result.task.id}`,
    `- Owner workspace: ${result.ownerWorkspace.workspace_dir}`,
    `- Reviewer snapshot: ${result.reviewerWorkspace.workspace_dir}`,
  ].join('\n');
}
