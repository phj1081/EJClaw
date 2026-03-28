import { execFileSync } from 'child_process';
import crypto from 'crypto';

import {
  SERVICE_ID,
  normalizeServiceId,
} from './config.js';
import {
  createPairedExecution,
  createPairedTask,
  getLatestOpenPairedTaskForChat,
  getPairedExecutionById,
  getPairedTaskById,
  updatePairedExecution,
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
  PairedExecution,
  PairedTask,
  PairedWorkspace,
  RegisteredGroup,
  RoomRoleContext,
} from './types.js';

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
    workspace_topology: 'shadow-snapshot',
    created_at: now,
    updated_at: now,
  });
  return group.workDir;
}

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
    task_policy: 'autonomous',
    risk_level: 'low',
    plan_status: 'not_requested',
    review_requested_at: null,
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

function ensureExecutionRecord(args: {
  runId: string;
  roomRoleContext: RoomRoleContext;
  task: PairedTask;
  workspace?: PairedWorkspace;
}): PairedExecution {
  const executionId = `${args.runId}:${args.roomRoleContext.serviceId}`;
  const existing = getPairedExecutionById(executionId);
  const now = new Date().toISOString();

  if (existing) {
    updatePairedExecution(existing.id, {
      workspace_id: args.workspace?.id ?? existing.workspace_id,
      status: 'running',
      started_at: existing.started_at ?? now,
    });
    return {
      ...existing,
      workspace_id: args.workspace?.id ?? existing.workspace_id,
      status: 'running',
      started_at: existing.started_at ?? now,
    };
  }

  const execution: PairedExecution = {
    id: executionId,
    task_id: args.task.id,
    service_id: args.roomRoleContext.serviceId,
    role: args.roomRoleContext.role,
    workspace_id: args.workspace?.id ?? null,
    status: 'running',
    summary: null,
    created_at: now,
    started_at: now,
    completed_at: null,
  };
  createPairedExecution(execution);
  return execution;
}

export interface PreparedPairedExecutionContext {
  task: PairedTask;
  execution: PairedExecution;
  workspace: PairedWorkspace | null;
  envOverrides: Record<string, string>;
  blockMessage?: string;
}

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
    };

export function preparePairedExecutionContext(args: {
  group: RegisteredGroup;
  chatJid: string;
  runId: string;
  roomRoleContext?: RoomRoleContext;
}): PreparedPairedExecutionContext | undefined {
  const { group, chatJid, runId, roomRoleContext } = args;
  if (!roomRoleContext || !group.workDir) {
    return undefined;
  }

  const task = ensureActiveTask(group, chatJid, roomRoleContext);
  if (!task) {
    return undefined;
  }

  let workspace: PairedWorkspace | null = null;
  let blockMessage: string | undefined;
  const now = new Date().toISOString();

  if (roomRoleContext.role === 'owner') {
    workspace = provisionOwnerWorkspaceForPairedTask(task.id);
  } else {
    const reviewerWorkspace = prepareReviewerWorkspaceForExecution(task);
    workspace = reviewerWorkspace.workspace;
    blockMessage = reviewerWorkspace.blockMessage;
    const latestTask = getPairedTaskById(task.id) ?? task;
    if (workspace && latestTask.status === 'review_ready') {
      updatePairedTask(task.id, {
        status: 'in_review',
        updated_at: now,
      });
    }
  }

  const execution = ensureExecutionRecord({
    runId,
    roomRoleContext,
    task,
    workspace: workspace ?? undefined,
  });
  const envOverrides: Record<string, string> = {
    EJCLAW_PAIRED_TASK_ID: task.id,
    EJCLAW_PAIRED_EXECUTION_ID: execution.id,
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
    execution,
    workspace,
    envOverrides,
    blockMessage,
  };
}

export function completePairedExecutionContext(args: {
  executionId: string;
  status: 'succeeded' | 'failed';
  summary?: string | null;
}): void {
  updatePairedExecution(args.executionId, {
    status: args.status,
    summary: args.summary ?? null,
    completed_at: new Date().toISOString(),
  });
}

export function markRoomReviewReady(args: {
  group: RegisteredGroup;
  chatJid: string;
  roomRoleContext?: RoomRoleContext;
}): MarkRoomReviewReadyResult | null {
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
  if (isOwnerService) {
    provisionOwnerWorkspaceForPairedTask(task.id);
  }

  const reviewReady = markPairedTaskReviewReady(task.id);
  const latestTask = getPairedTaskById(task.id) ?? task;
  if (!reviewReady) {
    return {
      status: 'pending',
      task: latestTask,
      pendingReason: 'owner-workspace-not-ready',
    };
  }

  const { ownerWorkspace, reviewerWorkspace } = reviewReady;
  return {
    status: 'ready',
    task: latestTask,
    ownerWorkspace,
    reviewerWorkspace,
  };
}

export function formatRoomReviewReadyMessage(
  result: MarkRoomReviewReadyResult | null,
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
