import fs from 'fs';
import path from 'path';

import { isUnsafeHostPairedModeEnabled } from 'ejclaw-runners-shared';

import { listAvailableGroups } from './available-groups.js';
import {
  ARBITER_AGENT_TYPE,
  REVIEWER_AGENT_TYPE,
  getRoleModelConfig,
  shouldForceFreshClaudeReviewerSessionInUnsafeHostMode,
} from './config.js';
import {
  getAllTasks,
  getLatestOpenPairedTaskForChat,
  markPairedTurnRunning,
} from './db.js';
import { createScopedLogger } from './logger.js';
import { buildRoomMemoryBriefing } from './sqlite-memory-store.js';
import type { PreparedPairedExecutionContext } from './paired-execution-context.js';
import { preparePairedExecutionContext } from './paired-execution-context.js';
import {
  resolveRuntimePairedTurnIdentity,
  type PairedTurnIdentity,
} from './paired-turn-identity.js';
import { resolveExecutionTarget } from './message-runtime-rules.js';
import { buildRoomRoleContext } from './room-role-context.js';
import { getEffectiveChannelLease } from './service-routing.js';
import { getTokenCount } from './token-rotation.js';
import { writeGroupsSnapshot, writeTasksSnapshot } from './agent-runner.js';
import type {
  AgentType,
  PairedRoomRole,
  RegisteredGroup,
  RoomRoleContext,
} from './types.js';

interface ExecutionTargetDeps {
  assistantName: string;
  getRoomBindings: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  clearSession: (groupFolder: string) => void;
}

interface ExecutionTargetArgs {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  runId: string;
  startSeq?: number | null;
  endSeq?: number | null;
  hasHumanMessage?: boolean;
  forcedRole?: PairedRoomRole;
  forcedAgentType?: AgentType;
  pairedTurnIdentity?: PairedTurnIdentity;
}

export interface PreparedMessageAgentExecution {
  currentLease: ReturnType<typeof getEffectiveChannelLease>;
  pairedTask: ReturnType<typeof getLatestOpenPairedTaskForChat> | null;
  activeRole: PairedRoomRole;
  effectiveServiceId: string;
  effectiveAgentType: AgentType;
  sessionFolder: string;
  reviewerMode: boolean;
  arbiterMode: boolean;
  effectiveGroup: RegisteredGroup;
  isClaudeCodeAgent: boolean;
  forceFreshClaudeReviewerSession: boolean;
  shouldPersistSession: boolean;
  currentSessionId: string | undefined;
  provider: 'claude' | 'codex';
  memoryBriefing: string | undefined;
  canRetryClaudeCredentials: boolean;
  roomRoleContext: RoomRoleContext | undefined;
  pairedExecutionContext: PreparedPairedExecutionContext | undefined;
  runtimePairedTurnIdentity: PairedTurnIdentity | undefined;
  log: ReturnType<typeof createScopedLogger>;
  clearRoleSdkSessions: () => void;
}

export async function prepareMessageAgentExecutionTarget(
  deps: ExecutionTargetDeps,
  args: ExecutionTargetArgs,
): Promise<PreparedMessageAgentExecution> {
  const { group, chatJid, runId, startSeq, endSeq } = args;
  const isMain = group.isMain === true;
  const sessions = deps.getSessions();

  const currentLease = getEffectiveChannelLease(chatJid);
  const pairedTask = currentLease.reviewer_agent_type
    ? getLatestOpenPairedTaskForChat(chatJid)
    : null;
  const executionTarget = resolveExecutionTarget({
    lease: currentLease,
    pairedTaskStatus: pairedTask?.status,
    groupFolder: group.folder,
    groupAgentType: group.agentType,
    forcedRole: args.forcedRole,
    forcedAgentType: args.forcedAgentType,
  });
  const {
    inferredRole,
    canHonorForcedRole,
    activeRole,
    effectiveServiceId,
    reviewerServiceId,
    arbiterServiceId,
    roleAgentPlan,
    configuredAgentType,
    effectiveAgentType,
    sessionFolder,
  } = executionTarget;
  const reviewerMode = activeRole === 'reviewer';
  const arbiterMode = activeRole === 'arbiter';
  const effectiveGroup =
    effectiveAgentType !== roleAgentPlan.ownerAgentType
      ? { ...group, agentType: effectiveAgentType }
      : group;
  const isClaudeCodeAgent = effectiveAgentType === 'claude-code';
  const unsafeHostPairedMode = isUnsafeHostPairedModeEnabled();
  const forceFreshClaudeReviewerSession =
    reviewerMode &&
    isClaudeCodeAgent &&
    unsafeHostPairedMode &&
    shouldForceFreshClaudeReviewerSessionInUnsafeHostMode();
  const shouldPersistSession =
    activeRole !== 'arbiter' &&
    !args.forcedAgentType &&
    !forceFreshClaudeReviewerSession;
  const storedSessionId = sessions[sessionFolder];
  if (forceFreshClaudeReviewerSession && storedSessionId) {
    deps.clearSession(sessionFolder);
  }
  const currentSessionId =
    activeRole === 'arbiter' ||
    args.forcedAgentType ||
    forceFreshClaudeReviewerSession
      ? undefined
      : storedSessionId;
  const provider = isClaudeCodeAgent ? 'claude' : 'codex';
  const memoryBriefing = currentSessionId
    ? undefined
    : await buildRoomMemoryBriefing({
        groupFolder: group.folder,
        groupName: group.name,
      }).catch(() => undefined);

  const tasks = getAllTasks(roleAgentPlan.ownerAgentType);
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((task) => ({
      id: task.id,
      groupFolder: task.group_folder,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    })),
  );

  writeGroupsSnapshot(
    group.folder,
    isMain,
    listAvailableGroups(deps.getRoomBindings()),
  );

  const claudeTokenCount = isClaudeCodeAgent ? getTokenCount() : 0;
  const canRetryClaudeCredentials = isClaudeCodeAgent && claudeTokenCount > 0;
  const roomRoleContext = buildRoomRoleContext(
    currentLease,
    effectiveServiceId,
    activeRole,
  );
  const pairedExecutionContext = preparePairedExecutionContext({
    group,
    chatJid,
    runId,
    roomRoleContext,
    hasHumanMessage: args.hasHumanMessage,
    pairedTurnIdentity: args.pairedTurnIdentity,
  });
  const preparedTurnTaskUpdatedAt = pairedExecutionContext
    ? (pairedExecutionContext.claimedTaskUpdatedAt ??
      pairedExecutionContext.task.updated_at)
    : undefined;
  const runtimePairedTurnIdentity =
    args.pairedTurnIdentity ??
    (pairedExecutionContext
      ? resolveRuntimePairedTurnIdentity({
          taskId: pairedExecutionContext.task.id,
          taskUpdatedAt:
            preparedTurnTaskUpdatedAt ?? pairedExecutionContext.task.updated_at,
          role: activeRole,
          taskStatus: pairedExecutionContext.task.status,
          hasHumanMessage: args.hasHumanMessage,
        })
      : pairedTask
        ? resolveRuntimePairedTurnIdentity({
            taskId: pairedTask.id,
            taskUpdatedAt: pairedTask.updated_at,
            role: activeRole,
            taskStatus: pairedTask.status,
            hasHumanMessage: args.hasHumanMessage,
          })
        : undefined);

  if (runtimePairedTurnIdentity) {
    if (runtimePairedTurnIdentity.role !== activeRole) {
      throw new Error(
        `Paired turn ${runtimePairedTurnIdentity.turnId} cannot execute as ${activeRole}`,
      );
    }
    if (
      pairedExecutionContext &&
      runtimePairedTurnIdentity.taskId !== pairedExecutionContext.task.id
    ) {
      throw new Error(
        `Paired turn ${runtimePairedTurnIdentity.turnId} task_id does not match the prepared execution context`,
      );
    }
    if (
      pairedExecutionContext &&
      runtimePairedTurnIdentity.taskUpdatedAt !== preparedTurnTaskUpdatedAt
    ) {
      throw new Error(
        `Paired turn ${runtimePairedTurnIdentity.turnId} task_updated_at does not match the prepared execution context`,
      );
    }
    if (
      !pairedExecutionContext &&
      pairedTask &&
      runtimePairedTurnIdentity.taskId !== pairedTask.id
    ) {
      throw new Error(
        `Paired turn ${runtimePairedTurnIdentity.turnId} task_id does not match the latest paired task`,
      );
    }
    if (
      !pairedExecutionContext &&
      pairedTask &&
      runtimePairedTurnIdentity.taskUpdatedAt !== pairedTask.updated_at
    ) {
      throw new Error(
        `Paired turn ${runtimePairedTurnIdentity.turnId} task_updated_at does not match the latest paired task`,
      );
    }
  }

  if (runtimePairedTurnIdentity) {
    markPairedTurnRunning({
      turnIdentity: runtimePairedTurnIdentity,
      executorServiceId: effectiveServiceId,
      executorAgentType: effectiveAgentType,
      runId,
    });
  }

  if (pairedExecutionContext && !args.forcedAgentType) {
    const roleConfig = getRoleModelConfig(activeRole);
    if (roleConfig.model) {
      const modelKey = isClaudeCodeAgent ? 'CLAUDE_MODEL' : 'CODEX_MODEL';
      pairedExecutionContext.envOverrides[modelKey] = roleConfig.model;
    }
    if (roleConfig.effort) {
      const effortKey = isClaudeCodeAgent ? 'CLAUDE_EFFORT' : 'CODEX_EFFORT';
      pairedExecutionContext.envOverrides[effortKey] = roleConfig.effort;
    }
  }
  if (pairedExecutionContext && runtimePairedTurnIdentity) {
    pairedExecutionContext.envOverrides.EJCLAW_PAIRED_TURN_ID =
      runtimePairedTurnIdentity.turnId;
    pairedExecutionContext.envOverrides.EJCLAW_PAIRED_TURN_ROLE =
      runtimePairedTurnIdentity.role;
    pairedExecutionContext.envOverrides.EJCLAW_PAIRED_TURN_INTENT =
      runtimePairedTurnIdentity.intentKind;
    pairedExecutionContext.envOverrides.EJCLAW_PAIRED_TASK_UPDATED_AT =
      runtimePairedTurnIdentity.taskUpdatedAt;
  }

  const log = createScopedLogger({
    chatJid,
    groupName: group.name,
    groupFolder: group.folder,
    runId,
    messageSeqStart: startSeq ?? undefined,
    messageSeqEnd: endSeq ?? undefined,
    role: activeRole,
    serviceId: effectiveServiceId,
    turnId: runtimePairedTurnIdentity?.turnId,
  });
  log.info(
    {
      forcedRole: args.forcedRole,
      forcedAgentType: args.forcedAgentType ?? null,
      inferredRole,
      canHonorForcedRole,
      pairedTaskId: pairedTask?.id,
      pairedTaskStatus: pairedTask?.status,
      configuredAgentType,
      effectiveServiceId,
      effectiveAgentType,
      groupAgentType: group.agentType,
      configuredReviewerAgentType: REVIEWER_AGENT_TYPE,
      configuredArbiterAgentType: ARBITER_AGENT_TYPE,
      reviewerServiceId,
      arbiterServiceId,
      reviewerAgentType: currentLease.reviewer_agent_type,
      arbiterAgentType: currentLease.arbiter_agent_type,
      reviewerMode,
      arbiterMode,
      sessionFolder,
      resumedSession: currentSessionId ?? null,
    },
    'Resolved execution target for agent turn',
  );

  const clearRoleSdkSessions = (): void => {
    const configDir = pairedExecutionContext?.envOverrides?.CLAUDE_CONFIG_DIR;
    if (!configDir) return;
    for (const sdkDir of ['.claude', '.codex']) {
      const sessionsDir = path.join(configDir, sdkDir, 'sessions');
      if (fs.existsSync(sessionsDir)) {
        fs.rmSync(sessionsDir, { recursive: true, force: true });
        log.info({ sessionsDir }, 'Cleared SDK sessions for fresh Claude turn');
      }
    }
  };

  return {
    currentLease,
    pairedTask,
    activeRole,
    effectiveServiceId,
    effectiveAgentType,
    sessionFolder,
    reviewerMode,
    arbiterMode,
    effectiveGroup,
    isClaudeCodeAgent,
    forceFreshClaudeReviewerSession,
    shouldPersistSession,
    currentSessionId,
    provider,
    memoryBriefing,
    canRetryClaudeCredentials,
    roomRoleContext,
    pairedExecutionContext,
    runtimePairedTurnIdentity,
    log,
    clearRoleSdkSessions,
  };
}
