import { execFileSync } from 'child_process';
import crypto from 'crypto';

import { SERVICE_ID, normalizeServiceId } from './config.js';
import {
  applyPairedEvent,
  cancelSupersededPairedExecutions,
  createPairedArtifact,
  createPairedExecution,
  createPairedTask,
  getLatestOpenPairedTaskForChat,
  getPairedExecutionById,
  getPairedTaskById,
  getPairedWorkspace,
  listPairedArtifactsForTask,
  listPairedEventsForTask,
  listPairedExecutionsForTask,
  updatePairedExecution,
  updatePairedTask,
  upsertPairedProject,
} from './db.js';
import { logger } from './logger.js';
import {
  PLAN_REVIEW_REQUIRED_BLOCK_MESSAGE,
  hasReviewableOwnerWorkspaceChanges,
  markPairedTaskReviewReady,
  prepareReviewerWorkspaceForExecution,
  provisionOwnerWorkspaceForPairedTask,
  resolvePairedTaskSourceFingerprint,
} from './paired-workspace-manager.js';
import type {
  PairedArtifactType,
  PairedEventType,
  PairedExecution,
  PairedGateTurnKind,
  PairedReviewerVerdict,
  PairedTask,
  PairedWorkspace,
  RegisteredGroup,
  RoomRoleContext,
} from './types.js';

const APPROVED_REVIEWER_GATE_VERDICTS = new Set<PairedReviewerVerdict>([
  'done',
  'done_with_concerns',
]);
const VISIBLE_REVIEWER_GATE_VERDICTS = new Set<PairedReviewerVerdict>([
  'done',
  'done_with_concerns',
  'blocked',
]);
const REVIEWER_GATE_REQUIRED_MESSAGE =
  'A visible reviewer verdict is required before the owner can proceed with this gate.';

function getGateTurnKind(task: PairedTask): PairedGateTurnKind | null {
  return task.gate_turn_kind ?? null;
}

function hasVisibleReviewerGateVerdict(
  verdict: PairedReviewerVerdict | null | undefined,
): boolean {
  return verdict ? VISIBLE_REVIEWER_GATE_VERDICTS.has(verdict) : false;
}

function allowsOwnerToProceedForGate(
  verdict: PairedReviewerVerdict | null | undefined,
): boolean {
  return verdict ? APPROVED_REVIEWER_GATE_VERDICTS.has(verdict) : false;
}

function formatOwnerGateBlockedMessage(task: PairedTask): string {
  return [
    REVIEWER_GATE_REQUIRED_MESSAGE,
    `- Task: ${task.id}`,
    `- Gate: ${task.gate_turn_kind ?? 'implementation_start'}`,
    `- Reviewer verdict: ${task.reviewer_verdict ?? 'missing'}`,
  ].join('\n');
}

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
    gate_turn_kind: null,
    reviewer_verdict: null,
    reviewer_verdict_at: null,
    reviewer_verdict_note: null,
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
  checkpointFingerprint?: string | null;
}): PairedExecution {
  const executionId = `${args.runId}:${args.roomRoleContext.serviceId}`;
  const existing = getPairedExecutionById(executionId);
  const now = new Date().toISOString();

  cancelSupersededPairedExecutions({
    taskId: args.task.id,
    role: args.roomRoleContext.role,
    exceptExecutionId: executionId,
    note: 'Superseded by a newer execution for the same task and role.',
  });

  if (existing) {
    updatePairedExecution(existing.id, {
      workspace_id: args.workspace?.id ?? existing.workspace_id,
      checkpoint_fingerprint:
        args.checkpointFingerprint ?? existing.checkpoint_fingerprint ?? null,
      status: 'running',
      started_at: existing.started_at ?? now,
    });
    return {
      ...existing,
      workspace_id: args.workspace?.id ?? existing.workspace_id,
      checkpoint_fingerprint:
        args.checkpointFingerprint ?? existing.checkpoint_fingerprint ?? null,
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
    checkpoint_fingerprint: args.checkpointFingerprint ?? null,
    status: 'running',
    summary: null,
    created_at: now,
    started_at: now,
    completed_at: null,
  };
  createPairedExecution(execution);
  return execution;
}

function getLatestReviewCheckpointFingerprint(taskId: string): string | null {
  const events = listPairedEventsForTask(taskId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.event_type === 'request_review' &&
      event.source_fingerprint?.trim()
    ) {
      return event.source_fingerprint.trim();
    }
  }
  return getPairedWorkspace(taskId, 'reviewer')?.snapshot_source_fingerprint ?? null;
}

function resolveExecutionCheckpointFingerprint(args: {
  taskId: string;
  role: RoomRoleContext['role'];
  workspace: PairedWorkspace | null;
}): string | null {
  if (args.role === 'reviewer') {
    return (
      args.workspace?.snapshot_source_fingerprint ??
      getLatestReviewCheckpointFingerprint(args.taskId)
    );
  }
  return resolvePairedTaskSourceFingerprint(args.taskId);
}

function isExecutionFreshForTaskStateWrite(args: {
  execution: PairedExecution;
}): boolean {
  if (args.execution.status === 'cancelled') {
    return false;
  }

  if (args.execution.role === 'owner') {
    const executionOrderKey = [
      args.execution.started_at ?? args.execution.created_at,
      args.execution.created_at,
      args.execution.id,
    ] as const;
    const hasNewerOwnerExecution = listPairedExecutionsForTask(
      args.execution.task_id,
    ).some((candidate) => {
      if (candidate.role !== 'owner' || candidate.id === args.execution.id) {
        return false;
      }
      const candidateOrderKey = [
        candidate.started_at ?? candidate.created_at,
        candidate.created_at,
        candidate.id,
      ] as const;
      if (candidateOrderKey[0] > executionOrderKey[0]) {
        return true;
      }
      if (candidateOrderKey[0] < executionOrderKey[0]) {
        return false;
      }
      if (candidateOrderKey[1] > executionOrderKey[1]) {
        return true;
      }
      if (candidateOrderKey[1] < executionOrderKey[1]) {
        return false;
      }
      return candidateOrderKey[2] > executionOrderKey[2];
    });
    return !hasNewerOwnerExecution;
  }

  const executionCheckpoint = args.execution.checkpoint_fingerprint ?? null;
  if (!executionCheckpoint) {
    return true;
  }

  const latestCheckpoint = getLatestReviewCheckpointFingerprint(
    args.execution.task_id,
  );
  if (!latestCheckpoint) {
    return true;
  }

  return executionCheckpoint === latestCheckpoint;
}

export interface PreparedPairedExecutionContext {
  task: PairedTask;
  execution: PairedExecution;
  workspace: PairedWorkspace | null;
  envOverrides: Record<string, string>;
  gateTurnKind?: PairedGateTurnKind | null;
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
  const { group, chatJid, runId, roomRoleContext } = args;
  if (!roomRoleContext || !group.workDir) {
    return undefined;
  }

  const task = ensureActiveTask(group, chatJid, roomRoleContext);
  if (!task) {
    return undefined;
  }

  const latestTask = getPairedTaskById(task.id) ?? task;
  const gateTurnKind = getGateTurnKind(latestTask);
  const requiresVisibleVerdict =
    roomRoleContext.role === 'reviewer' &&
    !!gateTurnKind &&
    !hasVisibleReviewerGateVerdict(latestTask.reviewer_verdict);
  let workspace: PairedWorkspace | null = null;
  let blockMessage: string | undefined;
  const now = new Date().toISOString();

  if (
    roomRoleContext.role === 'owner' &&
    gateTurnKind &&
    !allowsOwnerToProceedForGate(latestTask.reviewer_verdict)
  ) {
    blockMessage = formatOwnerGateBlockedMessage(latestTask);
  } else if (roomRoleContext.role === 'owner') {
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

  const execution = ensureExecutionRecord({
    runId,
    roomRoleContext,
    task: latestTask,
    workspace: workspace ?? undefined,
    checkpointFingerprint: resolveExecutionCheckpointFingerprint({
      taskId: latestTask.id,
      role: roomRoleContext.role,
      workspace,
    }),
  });
  const envOverrides: Record<string, string> = {
    EJCLAW_PAIRED_TASK_ID: latestTask.id,
    EJCLAW_PAIRED_EXECUTION_ID: execution.id,
    EJCLAW_PAIRED_ROLE: roomRoleContext.role,
  };

  if (workspace?.workspace_dir) {
    envOverrides.EJCLAW_WORK_DIR = workspace.workspace_dir;
  }
  if (roomRoleContext.role === 'reviewer') {
    envOverrides.EJCLAW_REVIEWER_RUNTIME = '1';
    if (requiresVisibleVerdict && gateTurnKind) {
      envOverrides.EJCLAW_PAIRED_GATE_TURN_KIND = gateTurnKind;
    }
  }

  return {
    task: getPairedTaskById(latestTask.id) ?? latestTask,
    execution,
    workspace,
    envOverrides,
    gateTurnKind,
    requiresVisibleVerdict,
    blockMessage,
  };
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
    }
  | {
      status: 'blocked';
      task: PairedTask;
      blockedReason: 'plan-review-required';
    }
  | null;

const PLAN_RECORD_OWNER_ONLY_MESSAGE =
  'Plan recording must be handled by the owner service.';
const RISK_UPDATE_OWNER_ONLY_MESSAGE =
  'Risk updates must be handled by the owner service.';
const PLAN_APPROVAL_REVIEWER_ONLY_MESSAGE =
  'Plan approval must be handled by the reviewer service.';
const PLAN_REQUIRES_HIGH_RISK_MESSAGE =
  'Plan review commands are only required for high-risk tasks.';
const PLAN_INCOMPLETE_MESSAGE =
  'Plan artifacts are incomplete. Record /plan <plan brief> || <acceptance criteria> || <risk summary> before approval.';
const AUTO_REQUEST_REVIEW_DEDUPE_PREFIX = 'auto-request-review';

function normalizeIntentDedupeKey(dedupeKey?: string): string {
  return dedupeKey?.trim() || crypto.randomUUID();
}

function serializeIntentPayload(
  payload?: Record<string, unknown>,
): string | null {
  if (!payload || Object.keys(payload).length === 0) {
    return null;
  }
  return JSON.stringify(payload);
}

function applyRoomIntent<T>(args: {
  task: PairedTask;
  roomRoleContext: RoomRoleContext;
  eventType: PairedEventType;
  dedupeKey?: string;
  payload?: Record<string, unknown>;
  onApply?: () => T;
}): {
  applied: boolean;
  result: T | null;
} {
  const createdAt = new Date().toISOString();
  const sourceFingerprint = resolvePairedTaskSourceFingerprint(args.task.id);
  const result = applyPairedEvent({
    event: {
      task_id: args.task.id,
      event_type: args.eventType,
      actor_role: args.roomRoleContext.role,
      source_service_id: args.roomRoleContext.serviceId,
      source_fingerprint: sourceFingerprint,
      dedupe_key: normalizeIntentDedupeKey(args.dedupeKey),
      payload_json: serializeIntentPayload(args.payload),
      created_at: createdAt,
    },
    onApply: args.onApply,
  });
  return {
    applied: result.applied,
    result: result.result,
  };
}

function isPlanReviewRequired(task: PairedTask): boolean {
  return task.risk_level === 'high' && task.plan_status !== 'approved';
}

function getLatestArtifactContent(
  taskId: string,
  artifactType: PairedArtifactType,
): string | null {
  const artifacts = listPairedArtifactsForTask(taskId).filter(
    (artifact) => artifact.artifact_type === artifactType,
  );
  return artifacts.at(-1)?.content?.trim() || null;
}

function hasCompletePlanArtifacts(taskId: string): boolean {
  return (
    !!getLatestArtifactContent(taskId, 'plan_brief') &&
    !!getLatestArtifactContent(taskId, 'acceptance_criteria') &&
    !!getLatestArtifactContent(taskId, 'risk_summary')
  );
}

function createTaskArtifact(args: {
  taskId: string;
  serviceId: string;
  artifactType: PairedArtifactType;
  content: string;
}): void {
  createPairedArtifact({
    task_id: args.taskId,
    execution_id: null,
    service_id: args.serviceId,
    artifact_type: args.artifactType,
    title: null,
    content: args.content,
    file_path: null,
    created_at: new Date().toISOString(),
  });
}

function getPersistedReviewReadyState(taskId: string): {
  ownerWorkspace: PairedWorkspace | null;
  reviewerWorkspace: PairedWorkspace | null;
} {
  return {
    ownerWorkspace: getPairedWorkspace(taskId, 'owner') ?? null,
    reviewerWorkspace: getPairedWorkspace(taskId, 'reviewer') ?? null,
  };
}

function formatPlanReviewRequiredMessage(task: PairedTask): string {
  return [
    PLAN_REVIEW_REQUIRED_BLOCK_MESSAGE,
    `- Task: ${task.id}`,
    `- Plan status: ${task.plan_status}`,
    'Ask the owner to record a plan and have the reviewer approve it before /review.',
  ].join('\n');
}

function hasRequestReviewForFingerprint(
  taskId: string,
  sourceFingerprint: string,
): boolean {
  return listPairedEventsForTask(taskId).some(
    (event) =>
      event.event_type === 'request_review' &&
      event.source_fingerprint === sourceFingerprint,
  );
}

function buildRoomRoleContextFromExecution(args: {
  task: PairedTask;
  execution: PairedExecution;
}): RoomRoleContext {
  return {
    serviceId: args.execution.service_id,
    role: args.execution.role,
    ownerServiceId: args.task.owner_service_id,
    reviewerServiceId: args.task.reviewer_service_id,
    failoverOwner: false,
  };
}

function getLatestExecutionForRole(
  taskId: string,
  role: PairedExecution['role'],
): PairedExecution | null {
  const executions = listPairedExecutionsForTask(taskId).filter(
    (execution) => execution.role === role,
  );
  return executions.at(-1) ?? null;
}

function buildPairedExecutionRecoveryPrompt(args: {
  task: PairedTask;
  role: RoomRoleContext['role'];
  checkpointFingerprint: string | null;
  mode: 'review' | 'owner-rework' | 'owner-resume';
}): string {
  const lines = [
    'Internal paired execution recovery.',
    '- This run was started automatically after service restart.',
    `- Task: ${args.task.id}`,
    `- Role: ${args.role}`,
    `- Status: ${args.task.status}`,
  ];
  if (args.checkpointFingerprint) {
    lines.push(`- Checkpoint: ${args.checkpointFingerprint}`);
  }

  if (args.mode === 'review') {
    lines.push(
      'Resume the formal paired review for the current checkpoint without waiting for a new user message.',
    );
  } else if (args.mode === 'owner-rework') {
    lines.push(
      'Resume the owner rework for the current task state without waiting for a new user message.',
    );
  } else {
    lines.push(
      'Resume the interrupted owner implementation for the current task without waiting for a new user message.',
    );
  }

  lines.push('- Keep the current task scope unchanged.');
  lines.push('- Follow the existing paired task guards and checkpoint rules.');
  return lines.join('\n');
}

export function planPairedExecutionRecovery(args: {
  group: RegisteredGroup;
  chatJid: string;
  roomRoleContext?: RoomRoleContext;
}): PairedExecutionRecoveryPlan | null {
  const { group, chatJid, roomRoleContext } = args;
  if (!roomRoleContext || !group.workDir) {
    return null;
  }

  const task = getLatestOpenPairedTaskForChat(chatJid);
  if (!task) {
    return null;
  }

  if (roomRoleContext.role === 'reviewer') {
    if (
      task.status !== 'review_pending' &&
      task.status !== 'review_ready' &&
      task.status !== 'in_review'
    ) {
      return null;
    }

    const checkpointFingerprint = getLatestReviewCheckpointFingerprint(task.id);
    if (!checkpointFingerprint) {
      return null;
    }

    return {
      task,
      role: 'reviewer',
      checkpointFingerprint,
      recoveryKey: `paired-recovery:${task.id}:reviewer:${checkpointFingerprint}`,
      prompt: buildPairedExecutionRecoveryPrompt({
        task,
        role: 'reviewer',
        checkpointFingerprint,
        mode: 'review',
      }),
    };
  }

  if (task.status === 'changes_requested') {
    const checkpointFingerprint =
      resolvePairedTaskSourceFingerprint(task.id) ?? null;
    return {
      task,
      role: 'owner',
      checkpointFingerprint,
      recoveryKey: `paired-recovery:${task.id}:owner:changes_requested:${
        checkpointFingerprint ?? 'none'
      }`,
      prompt: buildPairedExecutionRecoveryPrompt({
        task,
        role: 'owner',
        checkpointFingerprint,
        mode: 'owner-rework',
      }),
    };
  }

  if (task.status !== 'active') {
    return null;
  }

  const latestOwnerExecution = getLatestExecutionForRole(task.id, 'owner');
  if (latestOwnerExecution?.status !== 'running') {
    return null;
  }

  const checkpointFingerprint =
    resolvePairedTaskSourceFingerprint(task.id) ??
    latestOwnerExecution.checkpoint_fingerprint ??
    null;
  return {
    task,
    role: 'owner',
    checkpointFingerprint,
    recoveryKey: `paired-recovery:${task.id}:owner:active:${
      checkpointFingerprint ?? 'none'
    }`,
    prompt: buildPairedExecutionRecoveryPrompt({
      task,
      role: 'owner',
      checkpointFingerprint,
      mode: 'owner-resume',
    }),
  };
}

function markTaskReviewPendingWithoutSnapshot(taskId: string): void {
  const requestedAt = new Date().toISOString();
  updatePairedTask(taskId, {
    status: 'review_pending',
    review_requested_at: requestedAt,
    updated_at: requestedAt,
  });
}

function maybeAutoRequestReviewForCompletedExecution(args: {
  execution: PairedExecution;
  status: 'succeeded' | 'failed';
}): void {
  if (args.status !== 'succeeded') {
    return;
  }

  if (args.execution.role !== 'owner') {
    return;
  }

  const task = getPairedTaskById(args.execution.task_id);
  if (!task) {
    return;
  }

  if (isPlanReviewRequired(task)) {
    return;
  }

  const shouldOpenReview =
    task.status === 'active' || task.status === 'changes_requested';
  const shouldRecordUpdatedCheckpoint =
    task.status === 'review_pending' ||
    task.status === 'review_ready' ||
    task.status === 'in_review';

  if (!shouldOpenReview && !shouldRecordUpdatedCheckpoint) {
    return;
  }

  const ownerWorkspace = getPairedWorkspace(task.id, 'owner');
  if (!ownerWorkspace) {
    return;
  }

  const sourceFingerprint = resolvePairedTaskSourceFingerprint(task.id);
  if (!sourceFingerprint) {
    return;
  }

  if (!hasReviewableOwnerWorkspaceChanges(task.id)) {
    return;
  }

  if (hasRequestReviewForFingerprint(task.id, sourceFingerprint)) {
    return;
  }

  const roomRoleContext = buildRoomRoleContextFromExecution({
    task,
    execution: args.execution,
  });
  const reviewIntent = applyRoomIntent({
    task,
    roomRoleContext,
    eventType: 'request_review',
    dedupeKey: `${AUTO_REQUEST_REVIEW_DEDUPE_PREFIX}:${sourceFingerprint}`,
    onApply: () =>
      shouldOpenReview
        ? markPairedTaskReviewReady(task.id)
        : markTaskReviewPendingWithoutSnapshot(task.id),
  });

  if (reviewIntent.applied) {
    cancelSupersededPairedExecutions({
      taskId: task.id,
      role: 'reviewer',
      note: 'Superseded by a newer review checkpoint.',
    });
    logger.info(
      {
        taskId: task.id,
        executionId: args.execution.id,
        sourceFingerprint,
      },
      'Automatically requested review for low-risk owner checkpoint',
    );
  }
}

export function completePairedExecutionContext(args: {
  executionId: string;
  status: 'succeeded' | 'failed';
  summary?: string | null;
  reviewerVerdict?: PairedReviewerVerdict | null;
  reviewerVerdictNote?: string | null;
}): void {
  const execution = getPairedExecutionById(args.executionId);
  if (!execution) {
    return;
  }

  const completedAt = new Date().toISOString();
  const preservedStatus =
    execution.status === 'cancelled' ? execution.status : args.status;

  updatePairedExecution(args.executionId, {
    status: preservedStatus,
    summary: args.summary ?? null,
    completed_at: completedAt,
  });

  const completedExecution: PairedExecution = {
    ...execution,
    status: preservedStatus,
    summary: args.summary ?? null,
    completed_at: completedAt,
  };

  if (!isExecutionFreshForTaskStateWrite({ execution: completedExecution })) {
    logger.info(
      {
        taskId: completedExecution.task_id,
        executionId: completedExecution.id,
        role: completedExecution.role,
        checkpointFingerprint: completedExecution.checkpoint_fingerprint,
      },
      'Skipped task state write from stale paired execution',
    );
    return;
  }

  const task = getPairedTaskById(completedExecution.task_id);
  if (
    task &&
    completedExecution.role === 'reviewer' &&
    task.gate_turn_kind &&
    args.reviewerVerdict
  ) {
    updatePairedTask(task.id, {
      reviewer_verdict: args.reviewerVerdict,
      reviewer_verdict_at: completedAt,
      reviewer_verdict_note: args.reviewerVerdictNote ?? null,
      updated_at: completedAt,
    });
  }

  maybeAutoRequestReviewForCompletedExecution({
    execution: completedExecution,
    status: args.status,
  });
}

export function markRoomReviewReady(args: {
  group: RegisteredGroup;
  chatJid: string;
  roomRoleContext?: RoomRoleContext;
  dedupeKey?: string;
}): MarkRoomReviewReadyResult {
  const { group, chatJid, roomRoleContext, dedupeKey } = args;
  if (!roomRoleContext || !group.workDir) {
    return null;
  }

  const task = ensureActiveTask(group, chatJid, roomRoleContext);
  if (!task) {
    return null;
  }

  if (isPlanReviewRequired(task)) {
    return {
      status: 'blocked',
      task,
      blockedReason: 'plan-review-required',
    };
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

  const reviewIntent = applyRoomIntent({
    task,
    roomRoleContext,
    eventType: 'request_review',
    dedupeKey,
    onApply: () => markPairedTaskReviewReady(task.id),
  });

  if (reviewIntent.applied) {
    cancelSupersededPairedExecutions({
      taskId: task.id,
      role: 'reviewer',
      note: 'Superseded by a newer review checkpoint.',
    });
  }

  const latestTask = getPairedTaskById(task.id) ?? task;
  const { ownerWorkspace: persistedOwnerWorkspace, reviewerWorkspace } =
    getPersistedReviewReadyState(
    task.id,
    );

  if (reviewIntent.result) {
    return {
      status: 'ready',
      task: latestTask,
      ownerWorkspace: reviewIntent.result.ownerWorkspace,
      reviewerWorkspace: reviewIntent.result.reviewerWorkspace,
    };
  }

  if (!ownerWorkspace || !reviewerWorkspace) {
    return {
      status: 'pending',
      task: latestTask,
      pendingReason: 'owner-workspace-not-ready',
    };
  }
  return {
    status: 'ready',
    task: latestTask,
    ownerWorkspace: persistedOwnerWorkspace ?? ownerWorkspace,
    reviewerWorkspace,
  };
}

export function formatRoomReviewReadyMessage(
  result: MarkRoomReviewReadyResult,
): string | null {
  if (!result) {
    return null;
  }

  if (result.status === 'blocked') {
    return formatPlanReviewRequiredMessage(result.task);
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

export function setRoomTaskRiskLevel(args: {
  group: RegisteredGroup;
  chatJid: string;
  roomRoleContext?: RoomRoleContext;
  riskLevel: 'low' | 'high';
  dedupeKey?: string;
}): string | null {
  const { group, chatJid, roomRoleContext, riskLevel, dedupeKey } = args;
  if (!roomRoleContext || !group.workDir) {
    return null;
  }
  if (roomRoleContext.role !== 'owner') {
    return RISK_UPDATE_OWNER_ONLY_MESSAGE;
  }

  const task = ensureActiveTask(group, chatJid, roomRoleContext);
  if (!task) {
    return null;
  }

  applyRoomIntent({
    task,
    roomRoleContext,
    eventType: 'set_risk',
    dedupeKey,
    payload: { riskLevel },
    onApply: () => {
      const now = new Date().toISOString();
      if (riskLevel === 'high') {
        updatePairedTask(task.id, {
          risk_level: 'high',
          plan_status: hasCompletePlanArtifacts(task.id)
            ? 'pending'
            : 'not_requested',
          status: 'plan_review_pending',
          updated_at: now,
        });
        return;
      }

      updatePairedTask(task.id, {
        risk_level: 'low',
        status: task.status === 'plan_review_pending' ? 'active' : task.status,
        updated_at: now,
      });
    },
  });

  const latestTask = getPairedTaskById(task.id) ?? task;
  return [
    'Task risk updated.',
    `- Task: ${latestTask.id}`,
    `- Risk: ${latestTask.risk_level}`,
    `- Status: ${latestTask.status}`,
  ].join('\n');
}

export function recordRoomPlan(args: {
  group: RegisteredGroup;
  chatJid: string;
  roomRoleContext?: RoomRoleContext;
  planBrief: string;
  acceptanceCriteria: string;
  riskSummary: string;
  dedupeKey?: string;
}): string | null {
  const {
    group,
    chatJid,
    roomRoleContext,
    planBrief,
    acceptanceCriteria,
    riskSummary,
    dedupeKey,
  } = args;
  if (!roomRoleContext || !group.workDir) {
    return null;
  }
  if (roomRoleContext.role !== 'owner') {
    return PLAN_RECORD_OWNER_ONLY_MESSAGE;
  }

  const task = ensureActiveTask(group, chatJid, roomRoleContext);
  if (!task) {
    return null;
  }
  if (task.risk_level !== 'high') {
    return PLAN_REQUIRES_HIGH_RISK_MESSAGE;
  }

  applyRoomIntent({
    task,
    roomRoleContext,
    eventType: 'submit_plan',
    dedupeKey,
    payload: {
      planBrief,
      acceptanceCriteria,
      riskSummary,
    },
    onApply: () => {
      createTaskArtifact({
        taskId: task.id,
        serviceId: roomRoleContext.serviceId,
        artifactType: 'plan_brief',
        content: planBrief,
      });
      createTaskArtifact({
        taskId: task.id,
        serviceId: roomRoleContext.serviceId,
        artifactType: 'acceptance_criteria',
        content: acceptanceCriteria,
      });
      createTaskArtifact({
        taskId: task.id,
        serviceId: roomRoleContext.serviceId,
        artifactType: 'risk_summary',
        content: riskSummary,
      });

      updatePairedTask(task.id, {
        plan_status: 'pending',
        status: 'plan_review_pending',
        updated_at: new Date().toISOString(),
      });
    },
  });

  const latestTask = getPairedTaskById(task.id) ?? task;
  return [
    'Plan recorded.',
    `- Task: ${latestTask.id}`,
    `- Plan status: ${latestTask.plan_status}`,
    `- Status: ${latestTask.status}`,
  ].join('\n');
}

export function approveRoomPlan(args: {
  group: RegisteredGroup;
  chatJid: string;
  roomRoleContext?: RoomRoleContext;
  dedupeKey?: string;
}): string | null {
  const { group, chatJid, roomRoleContext, dedupeKey } = args;
  if (!roomRoleContext || !group.workDir) {
    return null;
  }
  if (roomRoleContext.role !== 'reviewer') {
    return PLAN_APPROVAL_REVIEWER_ONLY_MESSAGE;
  }

  const task = ensureActiveTask(group, chatJid, roomRoleContext);
  if (!task) {
    return null;
  }
  if (task.risk_level !== 'high') {
    return PLAN_REQUIRES_HIGH_RISK_MESSAGE;
  }
  if (!hasCompletePlanArtifacts(task.id)) {
    return PLAN_INCOMPLETE_MESSAGE;
  }

  applyRoomIntent({
    task,
    roomRoleContext,
    eventType: 'approve_plan',
    dedupeKey,
    onApply: () => {
      updatePairedTask(task.id, {
        plan_status: 'approved',
        status: 'active',
        updated_at: new Date().toISOString(),
      });
    },
  });

  const latestTask = getPairedTaskById(task.id) ?? task;
  return [
    'Plan approved.',
    `- Task: ${latestTask.id}`,
    `- Status: ${latestTask.status}`,
  ].join('\n');
}

export function requestRoomPlanChanges(args: {
  group: RegisteredGroup;
  chatJid: string;
  roomRoleContext?: RoomRoleContext;
  note?: string;
  dedupeKey?: string;
}): string | null {
  const { group, chatJid, roomRoleContext, note, dedupeKey } = args;
  if (!roomRoleContext || !group.workDir) {
    return null;
  }
  if (roomRoleContext.role !== 'reviewer') {
    return PLAN_APPROVAL_REVIEWER_ONLY_MESSAGE;
  }

  const task = ensureActiveTask(group, chatJid, roomRoleContext);
  if (!task) {
    return null;
  }
  if (task.risk_level !== 'high') {
    return PLAN_REQUIRES_HIGH_RISK_MESSAGE;
  }

  applyRoomIntent({
    task,
    roomRoleContext,
    eventType: 'request_plan_changes',
    dedupeKey,
    payload: note?.trim() ? { note: note.trim() } : undefined,
    onApply: () => {
      if (note?.trim()) {
        createTaskArtifact({
          taskId: task.id,
          serviceId: roomRoleContext.serviceId,
          artifactType: 'comment',
          content: note.trim(),
        });
      }

      updatePairedTask(task.id, {
        plan_status: 'changes_requested',
        status: 'plan_review_pending',
        updated_at: new Date().toISOString(),
      });
    },
  });

  const latestTask = getPairedTaskById(task.id) ?? task;
  return [
    'Plan changes requested.',
    `- Task: ${latestTask.id}`,
    `- Plan status: ${latestTask.plan_status}`,
    `- Status: ${latestTask.status}`,
  ].join('\n');
}
