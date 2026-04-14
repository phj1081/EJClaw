import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  buildPairedReadonlyRuntimeEnvOverrides,
  isUnsafeHostPairedModeEnabled,
} from 'ejclaw-runners-shared';

import {
  ARBITER_DEADLOCK_THRESHOLD,
  ARBITER_AGENT_TYPE,
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  DATA_DIR,
  PAIRED_MAX_ROUND_TRIPS,
  REVIEWER_AGENT_TYPE,
} from './config.js';
import {
  cancelPairedTurn,
  createPairedTask,
  getLatestPairedTaskForChat,
  getLatestOpenPairedTaskForChat,
  getPairedTaskById,
  getPairedTurnById,
  getPairedWorkspace,
  hasActiveCiWatcherForChat,
  releasePairedTaskExecutionLease,
  upsertPairedProject,
} from './db.js';
import { logger } from './logger.js';
import {
  handleArbiterCompletion,
  handleFailedArbiterExecution,
} from './paired-execution-context-arbiter.js';
import {
  handleFailedOwnerExecution,
  handleOwnerCompletion,
} from './paired-execution-context-owner.js';
import {
  handleFailedReviewerExecution,
  handleReviewerCompletion,
} from './paired-execution-context-reviewer.js';
import {
  applyPairedTaskPatch,
  resolveCanonicalSourceRef,
  requestArbiterOrEscalate,
  transitionPairedTaskStatus,
} from './paired-execution-context-shared.js';
import {
  isOwnerWorkspaceRepairNeededError,
  markPairedTaskReviewReady,
  prepareReviewerWorkspaceForExecution,
  provisionOwnerWorkspaceForPairedTask,
} from './paired-workspace-manager.js';
import {
  buildPairedTurnIdentity,
  type PairedTurnIdentity,
} from './paired-turn-identity.js';
import type {
  AgentType,
  PairedRoomRole,
  PairedTask,
  PairedWorkspace,
  RegisteredGroup,
  RoomRoleContext,
} from './types.js';
import { resolveRoleAgentPlan } from './role-agent-plan.js';

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

function resolvePairedTaskServiceShadow(
  role: 'owner' | 'reviewer',
  agentType: AgentType | null | undefined,
): string | null {
  if (!agentType) {
    return null;
  }

  if (agentType === 'claude-code') {
    return CLAUDE_SERVICE_ID;
  }

  return role === 'owner' ? CODEX_MAIN_SERVICE_ID : CODEX_REVIEW_SERVICE_ID;
}

function createActiveTaskForRoom(args: {
  group: RegisteredGroup;
  chatJid: string;
  canonicalWorkDir: string;
}): PairedTask {
  const { group, chatJid, canonicalWorkDir } = args;
  const now = new Date().toISOString();
  const rolePlan = resolveRoleAgentPlan({
    paired: true,
    groupAgentType: group.agentType,
    configuredReviewer: REVIEWER_AGENT_TYPE,
    configuredArbiter: ARBITER_AGENT_TYPE,
  });
  const ownerServiceShadow = resolvePairedTaskServiceShadow(
    'owner',
    rolePlan.ownerAgentType,
  )!;
  const reviewerServiceShadow = resolvePairedTaskServiceShadow(
    'reviewer',
    rolePlan.reviewerAgentType,
  )!;
  const task: PairedTask = {
    id: crypto.randomUUID(),
    chat_jid: chatJid,
    group_folder: group.folder,
    owner_service_id: ownerServiceShadow,
    reviewer_service_id: reviewerServiceShadow,
    owner_agent_type: rolePlan.ownerAgentType,
    reviewer_agent_type: rolePlan.reviewerAgentType,
    arbiter_agent_type: rolePlan.arbiterAgentType,
    title: null,
    source_ref: resolveCanonicalSourceRef(canonicalWorkDir),
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 0,
    owner_failure_count: 0,
    status: 'active',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
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

function cancelOutstandingFinalizeOwnerTurn(task: PairedTask): void {
  const turnIdentity = buildPairedTurnIdentity({
    taskId: task.id,
    taskUpdatedAt: task.updated_at,
    intentKind: 'finalize-owner-turn',
    role: 'owner',
  });
  const existingTurn = getPairedTurnById(turnIdentity.turnId);
  if (
    !existingTurn ||
    (existingTurn.state !== 'running' && existingTurn.state !== 'delegated')
  ) {
    return;
  }
  cancelPairedTurn({
    turnIdentity,
    error:
      'Superseded by a newer human message before owner finalize delivery.',
  });
  logger.info(
    {
      taskId: task.id,
      turnId: turnIdentity.turnId,
      turnState: existingTurn.state,
    },
    'Cancelled stale finalize-owner turn after a new human message superseded the merge_ready task',
  );
}

export interface ResolvedOwnerHumanTask {
  task: PairedTask | null;
  supersededTask: PairedTask | null;
}

export function resolveOwnerTaskForHumanMessage(args: {
  group: RegisteredGroup;
  chatJid: string;
  existingTask?: PairedTask | null;
}): ResolvedOwnerHumanTask {
  const canonicalWorkDir = ensurePairedProject(args.group, args.chatJid);
  const existing =
    args.existingTask ?? getLatestOpenPairedTaskForChat(args.chatJid) ?? null;

  if (!existing) {
    return {
      task: canonicalWorkDir
        ? createActiveTaskForRoom({
            group: args.group,
            chatJid: args.chatJid,
            canonicalWorkDir,
          })
        : null,
      supersededTask: null,
    };
  }

  if (existing.status !== 'merge_ready' || !canonicalWorkDir) {
    return {
      task: existing,
      supersededTask: null,
    };
  }

  const now = new Date().toISOString();
  const superseded = transitionPairedTaskStatus({
    taskId: existing.id,
    currentStatus: existing.status,
    nextStatus: 'completed',
    expectedUpdatedAt: existing.updated_at,
    updatedAt: now,
    patch: {
      completion_reason: 'superseded',
    },
  });

  if (!superseded) {
    return {
      task: getLatestOpenPairedTaskForChat(args.chatJid) ?? existing,
      supersededTask: null,
    };
  }

  cancelOutstandingFinalizeOwnerTurn(existing);

  return {
    task: createActiveTaskForRoom({
      group: args.group,
      chatJid: args.chatJid,
      canonicalWorkDir,
    }),
    supersededTask: existing,
  };
}

// ---------------------------------------------------------------------------
// ensureActiveTask
// ---------------------------------------------------------------------------

function ensureActiveTask(
  group: RegisteredGroup,
  chatJid: string,
  roomRoleContext: RoomRoleContext,
  hasHumanMessage?: boolean,
): PairedTask | null {
  const existing = getLatestOpenPairedTaskForChat(chatJid);
  if (roomRoleContext.role === 'owner' && hasHumanMessage) {
    return resolveOwnerTaskForHumanMessage({
      group,
      chatJid,
      existingTask: existing ?? null,
    }).task;
  }
  if (existing) {
    return existing;
  }

  // Don't create a new task for bot-only messages — prevents
  // ESCALATE → completed → bot message triggers new task → loop.
  if (!hasHumanMessage) {
    return null;
  }
  const canonicalWorkDir = ensurePairedProject(group, chatJid);
  if (!canonicalWorkDir) {
    return null;
  }
  return createActiveTaskForRoom({
    group,
    chatJid,
    canonicalWorkDir,
  });
}

// ---------------------------------------------------------------------------
// preparePairedExecutionContext
// ---------------------------------------------------------------------------

export interface PreparedPairedExecutionContext {
  task: PairedTask;
  claimedTaskUpdatedAt?: string;
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
  hasHumanMessage?: boolean;
  pairedTurnIdentity?: PairedTurnIdentity;
}): PreparedPairedExecutionContext | undefined {
  const { group, chatJid, roomRoleContext } = args;
  if (!roomRoleContext || !group.workDir) {
    return undefined;
  }

  const task = ensureActiveTask(
    group,
    chatJid,
    roomRoleContext,
    args.hasHumanMessage,
  );
  if (!task) {
    return undefined;
  }

  const latestTask = getPairedTaskById(task.id) ?? task;
  const continuationTurnIdentity = args.pairedTurnIdentity;
  const claimedTaskUpdatedAt =
    continuationTurnIdentity &&
    continuationTurnIdentity.taskId === latestTask.id &&
    continuationTurnIdentity.role === roomRoleContext.role &&
    ((roomRoleContext.role === 'reviewer' &&
      continuationTurnIdentity.intentKind === 'reviewer-turn' &&
      latestTask.status === 'in_review') ||
      (roomRoleContext.role === 'arbiter' &&
        continuationTurnIdentity.intentKind === 'arbiter-turn' &&
        latestTask.status === 'in_arbitration'))
      ? continuationTurnIdentity.taskUpdatedAt
      : latestTask.updated_at;
  let workspace: PairedWorkspace | null = null;
  let blockMessage: string | undefined;
  const now = new Date().toISOString();

  if (roomRoleContext.role === 'owner') {
    // New human message keeps the same task only for active review loops.
    // merge_ready is split into a fresh task before this function runs.
    // Only reset round_trip_count when a human message is present —
    // bot-only ping-pong must accumulate the counter for loop detection.
    const hasHuman = args.hasHumanMessage === true;
    const needsStatusReset =
      latestTask.status === 'review_ready' || latestTask.status === 'in_review';
    if (hasHuman || needsStatusReset) {
      if (needsStatusReset) {
        transitionPairedTaskStatus({
          taskId: latestTask.id,
          currentStatus: latestTask.status,
          nextStatus: 'active',
          expectedUpdatedAt: latestTask.updated_at,
          updatedAt: now,
          patch: {
            ...(hasHuman
              ? { round_trip_count: 0, owner_failure_count: 0 }
              : {}),
          },
        });
      } else {
        applyPairedTaskPatch({
          taskId: latestTask.id,
          expectedUpdatedAt: latestTask.updated_at,
          updatedAt: now,
          patch: {
            ...(hasHuman
              ? { round_trip_count: 0, owner_failure_count: 0 }
              : {}),
          },
        });
      }
    }
    // Use a stable per-channel worktree (not per-task) so the Claude SDK
    // session persists across tasks. Different channels still get isolation.
    try {
      workspace = provisionOwnerWorkspaceForPairedTask(latestTask.id);
    } catch (error) {
      if (isOwnerWorkspaceRepairNeededError(error)) {
        blockMessage = error.blockMessage || error.message;
      } else {
        throw error;
      }
    }
    // Update source_ref from workspace HEAD so change detection compares
    // against the correct repo. At task creation, source_ref is from the
    // canonical workDir which may differ from the workspace clone.
    if (workspace?.workspace_dir && latestTask.status === 'active') {
      const wsRef = resolveCanonicalSourceRef(workspace.workspace_dir);
      if (wsRef !== latestTask.source_ref) {
        applyPairedTaskPatch({
          taskId: latestTask.id,
          expectedUpdatedAt: latestTask.updated_at,
          updatedAt: now,
          patch: {
            source_ref: wsRef,
          },
        });
      }
    }
  } else if (roomRoleContext.role === 'reviewer') {
    const reviewerWorkspace = prepareReviewerWorkspaceForExecution(latestTask);
    workspace = reviewerWorkspace.workspace;
    blockMessage = reviewerWorkspace.blockMessage;
    const refreshedTask = getPairedTaskById(latestTask.id) ?? latestTask;
    if (workspace && refreshedTask.status === 'review_ready') {
      transitionPairedTaskStatus({
        taskId: latestTask.id,
        currentStatus: refreshedTask.status,
        nextStatus: 'in_review',
        expectedUpdatedAt: refreshedTask.updated_at,
        updatedAt: now,
      });
    }
  } else if (roomRoleContext.role === 'arbiter') {
    // Arbiter uses same read-only workspace as reviewer
    const reviewerWorkspace = prepareReviewerWorkspaceForExecution(latestTask);
    workspace = reviewerWorkspace.workspace;
    blockMessage = reviewerWorkspace.blockMessage;
    const refreshedTask = getPairedTaskById(latestTask.id) ?? latestTask;
    if (workspace && refreshedTask.status === 'arbiter_requested') {
      transitionPairedTaskStatus({
        taskId: latestTask.id,
        currentStatus: refreshedTask.status,
        nextStatus: 'in_arbitration',
        expectedUpdatedAt: refreshedTask.updated_at,
        updatedAt: now,
      });
    }
  }

  const envOverrides: Record<string, string> = {
    EJCLAW_PAIRED_TASK_ID: task.id,
    EJCLAW_PAIRED_ROLE: roomRoleContext.role,
  };
  const unsafeHostPairedMode = isUnsafeHostPairedModeEnabled();

  if (workspace?.workspace_dir) {
    envOverrides.EJCLAW_WORK_DIR = workspace.workspace_dir;
  }
  if (roomRoleContext.role === 'reviewer') {
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
    Object.assign(
      envOverrides,
      buildPairedReadonlyRuntimeEnvOverrides({
        role: 'reviewer',
        agentType: REVIEWER_AGENT_TYPE,
        unsafeHostPairedMode,
      }),
    );
  } else if (roomRoleContext.role === 'arbiter') {
    const arbiterSessionDir = path.join(
      DATA_DIR,
      'sessions',
      `${group.folder}-arbiter`,
    );
    // Clear arbiter session each invocation — each deadlock is a fresh
    // judgment call, previous verdicts should not bias the decision.
    fs.rmSync(arbiterSessionDir, { recursive: true, force: true });
    fs.mkdirSync(arbiterSessionDir, { recursive: true });
    envOverrides.CLAUDE_CONFIG_DIR = arbiterSessionDir;
    Object.assign(
      envOverrides,
      buildPairedReadonlyRuntimeEnvOverrides({
        role: 'arbiter',
        agentType: ARBITER_AGENT_TYPE ?? REVIEWER_AGENT_TYPE,
        unsafeHostPairedMode,
      }),
    );
  }

  return {
    task: getPairedTaskById(task.id) ?? task,
    claimedTaskUpdatedAt,
    workspace,
    envOverrides,
    requiresVisibleVerdict:
      roomRoleContext.role === 'reviewer' || roomRoleContext.role === 'arbiter',
    blockMessage,
  };
}

export function completePairedExecutionContext(args: {
  taskId: string;
  role: PairedRoomRole;
  status: 'succeeded' | 'failed';
  runId?: string;
  summary?: string | null;
}): void {
  const { taskId, role, status } = args;
  let completionError: unknown;
  logger.info(
    {
      taskId,
      role,
      status,
      summary: args.summary?.slice(0, 200),
    },
    'Paired execution completed',
  );

  try {
    const task = getPairedTaskById(taskId);
    if (!task) {
      return;
    }
    if (task.status === 'completed') {
      logger.info(
        {
          taskId,
          role,
          status,
          completionReason: task.completion_reason ?? null,
        },
        'Ignoring late paired execution completion for an already completed task',
      );
      return;
    }

    if (status !== 'succeeded') {
      if (role === 'reviewer') {
        handleFailedReviewerExecution({
          task,
          taskId,
          summary: args.summary,
        });
        return;
      }
      if (role === 'arbiter') {
        handleFailedArbiterExecution({ task, taskId });
        return;
      }
      handleFailedOwnerExecution({ task, taskId, summary: args.summary });
      return;
    }

    if (role === 'owner') {
      handleOwnerCompletion({ task, taskId, summary: args.summary });
      return;
    }

    if (role === 'reviewer') {
      handleReviewerCompletion({ task, taskId, summary: args.summary });
      return;
    }

    if (role === 'arbiter') {
      handleArbiterCompletion({ task, taskId, summary: args.summary });
    }
  } catch (error) {
    completionError = error;
    throw error;
  } finally {
    if (!args.runId) {
      return;
    }
    try {
      releasePairedTaskExecutionLease({ taskId, runId: args.runId });
    } catch (releaseError) {
      logger.error(
        {
          taskId,
          role,
          runId: args.runId,
          releaseError,
        },
        'Failed to release paired task execution lease after completion',
      );
      if (!completionError) {
        throw releaseError;
      }
    }
  }
}
