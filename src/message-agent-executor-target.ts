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
import { resolveExecutionTarget } from './message-runtime-rules.js';
import type { PreparedPairedExecutionContext } from './paired-execution-context.js';
import { preparePairedExecutionContext } from './paired-execution-context.js';
import {
  resolveRuntimePairedTurnIdentity,
  type PairedTurnIdentity,
} from './paired-turn-identity.js';
import { buildRoomRoleContext } from './room-role-context.js';
import { getEffectiveChannelLease } from './service-routing.js';
import { buildRoomMemoryBriefing } from './sqlite-memory-store.js';
import { getTokenCount } from './token-rotation.js';
import type {
  AgentType,
  PairedRoomRole,
  RegisteredGroup,
  RoomRoleContext,
} from './types.js';
import { writeGroupsSnapshot, writeTasksSnapshot } from './agent-runner.js';

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

type CurrentChannelLease = ReturnType<typeof getEffectiveChannelLease>;
type LatestOpenPairedTask = ReturnType<typeof getLatestOpenPairedTaskForChat>;
type ResolvedExecutionTarget = ReturnType<typeof resolveExecutionTarget>;

interface ResolvedRoleExecutionState {
  reviewerMode: boolean;
  arbiterMode: boolean;
  effectiveGroup: RegisteredGroup;
  isClaudeCodeAgent: boolean;
  forceFreshClaudeReviewerSession: boolean;
  shouldPersistSession: boolean;
  currentSessionId: string | undefined;
  provider: 'claude' | 'codex';
}

interface RuntimePairedTurnResolution {
  preparedTurnTaskUpdatedAt: string | undefined;
  runtimePairedTurnIdentity: PairedTurnIdentity | undefined;
}

export async function prepareMessageAgentExecutionTarget(
  deps: ExecutionTargetDeps,
  args: ExecutionTargetArgs,
): Promise<PreparedMessageAgentExecution> {
  return new MessageAgentExecutionTargetPreparer(deps, args).run();
}

class MessageAgentExecutionTargetPreparer {
  constructor(
    private readonly deps: ExecutionTargetDeps,
    private readonly args: ExecutionTargetArgs,
  ) {}

  async run(): Promise<PreparedMessageAgentExecution> {
    const currentLease = getEffectiveChannelLease(this.args.chatJid);
    const pairedTask = this.resolveLatestPairedTask(currentLease);
    const executionTarget = this.resolveTarget(currentLease, pairedTask);
    const roleState = this.resolveRoleExecutionState(executionTarget);
    const memoryBriefing = await this.resolveMemoryBriefing(
      roleState.currentSessionId,
    );
    this.writeAgentSnapshots(executionTarget.roleAgentPlan.ownerAgentType);
    const canRetryClaudeCredentials = this.canRetryClaudeCredentials(
      roleState.isClaudeCodeAgent,
    );
    const roomRoleContext = buildRoomRoleContext(
      currentLease,
      executionTarget.effectiveServiceId,
      executionTarget.activeRole,
    );
    const pairedExecutionContext = this.preparePairedContext(roomRoleContext);
    const runtimeTurn = this.resolveRuntimePairedTurnIdentity({
      pairedTask,
      pairedExecutionContext,
      activeRole: executionTarget.activeRole,
    });
    this.validateRuntimePairedTurnIdentity({
      pairedTask,
      pairedExecutionContext,
      activeRole: executionTarget.activeRole,
      runtimeTurn,
    });
    this.markRuntimePairedTurnRunning(
      runtimeTurn.runtimePairedTurnIdentity,
      executionTarget,
    );
    this.applyPairedEnvOverrides({
      pairedExecutionContext,
      runtimePairedTurnIdentity: runtimeTurn.runtimePairedTurnIdentity,
      activeRole: executionTarget.activeRole,
      isClaudeCodeAgent: roleState.isClaudeCodeAgent,
    });
    const log = this.createExecutionLogger({
      currentLease,
      pairedTask,
      executionTarget,
      roleState,
      runtimePairedTurnIdentity: runtimeTurn.runtimePairedTurnIdentity,
    });

    return {
      currentLease,
      pairedTask,
      activeRole: executionTarget.activeRole,
      effectiveServiceId: executionTarget.effectiveServiceId,
      effectiveAgentType: executionTarget.effectiveAgentType,
      sessionFolder: executionTarget.sessionFolder,
      reviewerMode: roleState.reviewerMode,
      arbiterMode: roleState.arbiterMode,
      effectiveGroup: roleState.effectiveGroup,
      isClaudeCodeAgent: roleState.isClaudeCodeAgent,
      forceFreshClaudeReviewerSession:
        roleState.forceFreshClaudeReviewerSession,
      shouldPersistSession: roleState.shouldPersistSession,
      currentSessionId: roleState.currentSessionId,
      provider: roleState.provider,
      memoryBriefing,
      canRetryClaudeCredentials,
      roomRoleContext,
      pairedExecutionContext,
      runtimePairedTurnIdentity: runtimeTurn.runtimePairedTurnIdentity,
      log,
      clearRoleSdkSessions: this.createClearRoleSdkSessions(
        pairedExecutionContext,
        log,
      ),
    };
  }

  private resolveLatestPairedTask(
    currentLease: CurrentChannelLease,
  ): LatestOpenPairedTask | null {
    return currentLease.reviewer_agent_type
      ? getLatestOpenPairedTaskForChat(this.args.chatJid)
      : null;
  }

  private resolveTarget(
    currentLease: CurrentChannelLease,
    pairedTask: LatestOpenPairedTask | null,
  ): ResolvedExecutionTarget {
    return resolveExecutionTarget({
      lease: currentLease,
      pairedTaskStatus: pairedTask?.status,
      groupFolder: this.args.group.folder,
      groupAgentType: this.args.group.agentType,
      forcedRole: this.args.forcedRole,
      forcedAgentType: this.args.forcedAgentType,
    });
  }

  private resolveRoleExecutionState(
    executionTarget: ResolvedExecutionTarget,
  ): ResolvedRoleExecutionState {
    const reviewerMode = executionTarget.activeRole === 'reviewer';
    const arbiterMode = executionTarget.activeRole === 'arbiter';
    const effectiveGroup =
      executionTarget.effectiveAgentType !==
      executionTarget.roleAgentPlan.ownerAgentType
        ? {
            ...this.args.group,
            agentType: executionTarget.effectiveAgentType,
          }
        : this.args.group;
    const isClaudeCodeAgent =
      executionTarget.effectiveAgentType === 'claude-code';
    const forceFreshClaudeReviewerSession =
      reviewerMode &&
      isClaudeCodeAgent &&
      isUnsafeHostPairedModeEnabled() &&
      shouldForceFreshClaudeReviewerSessionInUnsafeHostMode();
    const shouldPersistSession =
      executionTarget.activeRole !== 'arbiter' &&
      !this.args.forcedAgentType &&
      !forceFreshClaudeReviewerSession;
    const storedSessionId =
      this.deps.getSessions()[executionTarget.sessionFolder];
    if (forceFreshClaudeReviewerSession && storedSessionId) {
      this.deps.clearSession(executionTarget.sessionFolder);
    }
    const currentSessionId =
      executionTarget.activeRole === 'arbiter' ||
      this.args.forcedAgentType ||
      forceFreshClaudeReviewerSession
        ? undefined
        : storedSessionId;
    return {
      reviewerMode,
      arbiterMode,
      effectiveGroup,
      isClaudeCodeAgent,
      forceFreshClaudeReviewerSession,
      shouldPersistSession,
      currentSessionId,
      provider: isClaudeCodeAgent ? 'claude' : 'codex',
    };
  }

  private async resolveMemoryBriefing(
    currentSessionId: string | undefined,
  ): Promise<string | undefined> {
    if (currentSessionId) {
      return undefined;
    }
    return buildRoomMemoryBriefing({
      groupFolder: this.args.group.folder,
      groupName: this.args.group.name,
    }).catch(() => undefined);
  }

  private writeAgentSnapshots(ownerAgentType: AgentType): void {
    const tasks = getAllTasks(ownerAgentType);
    writeTasksSnapshot(
      this.args.group.folder,
      this.args.group.isMain === true,
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
      this.args.group.folder,
      this.args.group.isMain === true,
      listAvailableGroups(this.deps.getRoomBindings()),
    );
  }

  private canRetryClaudeCredentials(isClaudeCodeAgent: boolean): boolean {
    return isClaudeCodeAgent && getTokenCount() > 0;
  }

  private preparePairedContext(
    roomRoleContext: RoomRoleContext | undefined,
  ): PreparedPairedExecutionContext | undefined {
    return preparePairedExecutionContext({
      group: this.args.group,
      chatJid: this.args.chatJid,
      runId: this.args.runId,
      roomRoleContext,
      hasHumanMessage: this.args.hasHumanMessage,
      pairedTurnIdentity: this.args.pairedTurnIdentity,
    });
  }

  private resolveRuntimePairedTurnIdentity(args: {
    pairedTask: LatestOpenPairedTask | null;
    pairedExecutionContext: PreparedPairedExecutionContext | undefined;
    activeRole: PairedRoomRole;
  }): RuntimePairedTurnResolution {
    const preparedTurnTaskUpdatedAt = args.pairedExecutionContext
      ? (args.pairedExecutionContext.claimedTaskUpdatedAt ??
        args.pairedExecutionContext.task.updated_at)
      : undefined;
    const runtimePairedTurnIdentity =
      this.args.pairedTurnIdentity ??
      this.resolveCurrentRuntimePairedTurnIdentity({
        ...args,
        preparedTurnTaskUpdatedAt,
      });
    return { preparedTurnTaskUpdatedAt, runtimePairedTurnIdentity };
  }

  private resolveCurrentRuntimePairedTurnIdentity(args: {
    pairedTask: LatestOpenPairedTask | null;
    pairedExecutionContext: PreparedPairedExecutionContext | undefined;
    activeRole: PairedRoomRole;
    preparedTurnTaskUpdatedAt: string | undefined;
  }): PairedTurnIdentity | undefined {
    if (args.pairedExecutionContext) {
      return resolveRuntimePairedTurnIdentity({
        taskId: args.pairedExecutionContext.task.id,
        taskUpdatedAt:
          args.preparedTurnTaskUpdatedAt ??
          args.pairedExecutionContext.task.updated_at,
        role: args.activeRole,
        taskStatus: args.pairedExecutionContext.task.status,
        hasHumanMessage: this.args.hasHumanMessage,
      });
    }
    if (!args.pairedTask) {
      return undefined;
    }
    return resolveRuntimePairedTurnIdentity({
      taskId: args.pairedTask.id,
      taskUpdatedAt: args.pairedTask.updated_at,
      role: args.activeRole,
      taskStatus: args.pairedTask.status,
      hasHumanMessage: this.args.hasHumanMessage,
    });
  }

  private validateRuntimePairedTurnIdentity(args: {
    pairedTask: LatestOpenPairedTask | null;
    pairedExecutionContext: PreparedPairedExecutionContext | undefined;
    activeRole: PairedRoomRole;
    runtimeTurn: RuntimePairedTurnResolution;
  }): void {
    const { runtimePairedTurnIdentity, preparedTurnTaskUpdatedAt } =
      args.runtimeTurn;
    if (!runtimePairedTurnIdentity) {
      return;
    }
    if (runtimePairedTurnIdentity.role !== args.activeRole) {
      throw new Error(
        `Paired turn ${runtimePairedTurnIdentity.turnId} cannot execute as ${args.activeRole}`,
      );
    }
    this.validatePreparedContextTurnIdentity({
      pairedExecutionContext: args.pairedExecutionContext,
      runtimePairedTurnIdentity,
      preparedTurnTaskUpdatedAt,
    });
    this.validateLatestTaskTurnIdentity({
      pairedTask: args.pairedTask,
      pairedExecutionContext: args.pairedExecutionContext,
      runtimePairedTurnIdentity,
    });
  }

  private validatePreparedContextTurnIdentity(args: {
    pairedExecutionContext: PreparedPairedExecutionContext | undefined;
    runtimePairedTurnIdentity: PairedTurnIdentity;
    preparedTurnTaskUpdatedAt: string | undefined;
  }): void {
    if (!args.pairedExecutionContext) {
      return;
    }
    if (
      args.runtimePairedTurnIdentity.taskId !==
      args.pairedExecutionContext.task.id
    ) {
      throw new Error(
        `Paired turn ${args.runtimePairedTurnIdentity.turnId} task_id does not match the prepared execution context`,
      );
    }
    if (
      args.runtimePairedTurnIdentity.taskUpdatedAt !==
      args.preparedTurnTaskUpdatedAt
    ) {
      throw new Error(
        `Paired turn ${args.runtimePairedTurnIdentity.turnId} task_updated_at does not match the prepared execution context`,
      );
    }
  }

  private validateLatestTaskTurnIdentity(args: {
    pairedTask: LatestOpenPairedTask | null;
    pairedExecutionContext: PreparedPairedExecutionContext | undefined;
    runtimePairedTurnIdentity: PairedTurnIdentity;
  }): void {
    if (args.pairedExecutionContext || !args.pairedTask) {
      return;
    }
    if (args.runtimePairedTurnIdentity.taskId !== args.pairedTask.id) {
      throw new Error(
        `Paired turn ${args.runtimePairedTurnIdentity.turnId} task_id does not match the latest paired task`,
      );
    }
    if (
      args.runtimePairedTurnIdentity.taskUpdatedAt !==
      args.pairedTask.updated_at
    ) {
      throw new Error(
        `Paired turn ${args.runtimePairedTurnIdentity.turnId} task_updated_at does not match the latest paired task`,
      );
    }
  }

  private markRuntimePairedTurnRunning(
    runtimePairedTurnIdentity: PairedTurnIdentity | undefined,
    executionTarget: ResolvedExecutionTarget,
  ): void {
    if (!runtimePairedTurnIdentity) {
      return;
    }
    markPairedTurnRunning({
      turnIdentity: runtimePairedTurnIdentity,
      executorServiceId: executionTarget.effectiveServiceId,
      executorAgentType: executionTarget.effectiveAgentType,
      runId: this.args.runId,
    });
  }

  private applyPairedEnvOverrides(args: {
    pairedExecutionContext: PreparedPairedExecutionContext | undefined;
    runtimePairedTurnIdentity: PairedTurnIdentity | undefined;
    activeRole: PairedRoomRole;
    isClaudeCodeAgent: boolean;
  }): void {
    this.applyRoleModelEnvOverrides(args);
    this.applyRuntimePairedTurnEnvOverrides(args);
  }

  private applyRoleModelEnvOverrides(args: {
    pairedExecutionContext: PreparedPairedExecutionContext | undefined;
    activeRole: PairedRoomRole;
    isClaudeCodeAgent: boolean;
  }): void {
    if (!args.pairedExecutionContext || this.args.forcedAgentType) {
      return;
    }
    const roleConfig = getRoleModelConfig(args.activeRole);
    if (roleConfig.model) {
      const modelKey = args.isClaudeCodeAgent ? 'CLAUDE_MODEL' : 'CODEX_MODEL';
      args.pairedExecutionContext.envOverrides[modelKey] = roleConfig.model;
    }
    if (roleConfig.effort) {
      const effortKey = args.isClaudeCodeAgent
        ? 'CLAUDE_EFFORT'
        : 'CODEX_EFFORT';
      args.pairedExecutionContext.envOverrides[effortKey] = roleConfig.effort;
    }
  }

  private applyRuntimePairedTurnEnvOverrides(args: {
    pairedExecutionContext: PreparedPairedExecutionContext | undefined;
    runtimePairedTurnIdentity: PairedTurnIdentity | undefined;
  }): void {
    if (!args.pairedExecutionContext || !args.runtimePairedTurnIdentity) {
      return;
    }
    args.pairedExecutionContext.envOverrides.EJCLAW_PAIRED_TURN_ID =
      args.runtimePairedTurnIdentity.turnId;
    args.pairedExecutionContext.envOverrides.EJCLAW_PAIRED_TURN_ROLE =
      args.runtimePairedTurnIdentity.role;
    args.pairedExecutionContext.envOverrides.EJCLAW_PAIRED_TURN_INTENT =
      args.runtimePairedTurnIdentity.intentKind;
    args.pairedExecutionContext.envOverrides.EJCLAW_PAIRED_TASK_UPDATED_AT =
      args.runtimePairedTurnIdentity.taskUpdatedAt;
  }

  private createExecutionLogger(args: {
    currentLease: CurrentChannelLease;
    pairedTask: LatestOpenPairedTask | null;
    executionTarget: ResolvedExecutionTarget;
    roleState: ResolvedRoleExecutionState;
    runtimePairedTurnIdentity: PairedTurnIdentity | undefined;
  }): ReturnType<typeof createScopedLogger> {
    const log = createScopedLogger({
      chatJid: this.args.chatJid,
      groupName: this.args.group.name,
      groupFolder: this.args.group.folder,
      runId: this.args.runId,
      messageSeqStart: this.args.startSeq ?? undefined,
      messageSeqEnd: this.args.endSeq ?? undefined,
      role: args.executionTarget.activeRole,
      serviceId: args.executionTarget.effectiveServiceId,
      turnId: args.runtimePairedTurnIdentity?.turnId,
    });
    log.info(
      {
        forcedRole: this.args.forcedRole,
        forcedAgentType: this.args.forcedAgentType ?? null,
        inferredRole: args.executionTarget.inferredRole,
        canHonorForcedRole: args.executionTarget.canHonorForcedRole,
        pairedTaskId: args.pairedTask?.id,
        pairedTaskStatus: args.pairedTask?.status,
        configuredAgentType: args.executionTarget.configuredAgentType,
        effectiveServiceId: args.executionTarget.effectiveServiceId,
        effectiveAgentType: args.executionTarget.effectiveAgentType,
        groupAgentType: this.args.group.agentType,
        configuredReviewerAgentType: REVIEWER_AGENT_TYPE,
        configuredArbiterAgentType: ARBITER_AGENT_TYPE,
        reviewerServiceId: args.executionTarget.reviewerServiceId,
        arbiterServiceId: args.executionTarget.arbiterServiceId,
        reviewerAgentType: args.currentLease.reviewer_agent_type,
        arbiterAgentType: args.currentLease.arbiter_agent_type,
        reviewerMode: args.roleState.reviewerMode,
        arbiterMode: args.roleState.arbiterMode,
        sessionFolder: args.executionTarget.sessionFolder,
        resumedSession: args.roleState.currentSessionId ?? null,
      },
      'Resolved execution target for agent turn',
    );
    return log;
  }

  private createClearRoleSdkSessions(
    pairedExecutionContext: PreparedPairedExecutionContext | undefined,
    log: ReturnType<typeof createScopedLogger>,
  ): () => void {
    return () => {
      const configDir = pairedExecutionContext?.envOverrides?.CLAUDE_CONFIG_DIR;
      if (!configDir) return;
      for (const sdkDir of ['.claude', '.codex']) {
        const sessionsDir = path.join(configDir, sdkDir, 'sessions');
        if (fs.existsSync(sessionsDir)) {
          fs.rmSync(sessionsDir, { recursive: true, force: true });
          log.info(
            { sessionsDir },
            'Cleared SDK sessions for fresh Claude turn',
          );
        }
      }
    };
  }
}
