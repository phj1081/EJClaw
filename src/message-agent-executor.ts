import { AgentOutput } from './agent-runner.js';
import { GroupQueue } from './group-queue.js';
import type { AgentTriggerReason } from './agent-error-detection.js';
import { getMoaConfig } from './config.js';
import { createPairedExecutionLifecycle } from './message-agent-executor-paired.js';
import type { PairedTurnIdentity } from './paired-turn-identity.js';
import { executeMessageAgentAttemptLifecycle } from './message-agent-executor-lifecycle.js';
import { runMessageAgentAttempt } from './message-agent-executor-attempt-runner.js';
import { handoffMessageAgentExecutionToCodex } from './message-agent-executor-handoff.js';
import { prepareMessageAgentExecutionTarget } from './message-agent-executor-target.js';
import { collectMoaReferences, formatMoaReferencesForPrompt } from './moa.js';
import { readArbiterPrompt } from './platform-prompts.js';
import { shouldRetryFreshSessionOnAgentFailure } from './session-recovery.js';
import type { AgentType, PairedRoomRole, RegisteredGroup } from './types.js';

// ── Main executor ─────────────────────────────────────────────────

export interface MessageAgentExecutorDeps {
  assistantName: string;
  queue: Pick<GroupQueue, 'registerProcess' | 'enqueueMessageCheck'> &
    Partial<Pick<GroupQueue, 'getDirectTerminalDeliveryForRun'>>;
  getRoomBindings: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  persistSession: (groupFolder: string, sessionId: string) => void;
  clearSession: (groupFolder: string) => void;
}

export async function runAgentForGroup(
  deps: MessageAgentExecutorDeps,
  args: {
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
    onOutput?: (output: AgentOutput) => Promise<void>;
  },
): Promise<'success' | 'error'> {
  const { group, prompt, chatJid, runId, startSeq, endSeq, onOutput } = args;
  const isMain = group.isMain === true;
  const preparedExecution = await prepareMessageAgentExecutionTarget(deps, {
    group,
    prompt,
    chatJid,
    runId,
    startSeq,
    endSeq,
    hasHumanMessage: args.hasHumanMessage,
    forcedRole: args.forcedRole,
    forcedAgentType: args.forcedAgentType,
    pairedTurnIdentity: args.pairedTurnIdentity,
  });
  const {
    currentLease,
    activeRole,
    effectiveServiceId,
    effectiveAgentType,
    sessionFolder,
    arbiterMode,
    effectiveGroup,
    isClaudeCodeAgent,
    forceFreshClaudeReviewerSession,
    shouldPersistSession,
    provider,
    memoryBriefing,
    canRetryClaudeCredentials,
    roomRoleContext,
    pairedExecutionContext,
    runtimePairedTurnIdentity,
    log,
    clearRoleSdkSessions,
  } = preparedExecution;
  let currentSessionId = preparedExecution.currentSessionId;

  if (forceFreshClaudeReviewerSession) {
    clearRoleSdkSessions();
  }

  // ── MoA prompt enrichment ─────────────────────────────────────
  // When MoA is enabled and we're in arbiter mode, query external API
  // models (Kimi, GLM, etc.) in parallel for their opinions, then inject
  // those opinions into the arbiter's prompt. The SDK-based arbiter
  // agent naturally aggregates all perspectives.
  let moaEnrichedPrompt = prompt;
  const moaConfig = getMoaConfig();
  if (arbiterMode && moaConfig.enabled && pairedExecutionContext) {
    log.info(
      {
        models: moaConfig.referenceModels.map((m) => m.name),
      },
      'MoA: collecting reference opinions before arbiter',
    );

    const systemPrompt =
      readArbiterPrompt(process.cwd()) || 'You are an arbiter.';

    try {
      const references = await collectMoaReferences({
        config: moaConfig,
        systemPrompt,
        contextPrompt: prompt,
      });

      const moaSection = formatMoaReferencesForPrompt(references);
      if (moaSection) {
        moaEnrichedPrompt = prompt + '\n' + moaSection;
        log.info(
          {
            successCount: references.filter((r) => !r.error).length,
            totalCount: references.length,
          },
          'MoA: injected reference opinions into arbiter prompt',
        );
      }
    } catch (err) {
      log.warn(
        {
          err,
          models: moaConfig.referenceModels.map((m) => m.name),
        },
        'MoA: failed to collect reference opinions; continuing without enrichment',
      );
    }
  }

  const effectivePrompt = moaEnrichedPrompt;
  const pairedExecutionLifecycle = createPairedExecutionLifecycle({
    pairedExecutionContext,
    pairedTurnIdentity: runtimePairedTurnIdentity,
    completedRole: runtimePairedTurnIdentity?.role ?? activeRole,
    chatJid,
    runId,
    enqueueMessageCheck: () => deps.queue.enqueueMessageCheck(chatJid),
    getDirectTerminalDeliveryText: () =>
      deps.queue.getDirectTerminalDeliveryForRun?.(
        chatJid,
        runId,
        runtimePairedTurnIdentity?.role ?? activeRole,
      ) ?? null,
    onOutput,
    log,
  });
  const hasDirectTerminalDelivery = (): boolean =>
    !!deps.queue.getDirectTerminalDeliveryForRun?.(
      chatJid,
      runId,
      runtimePairedTurnIdentity?.role ?? activeRole,
    );

  const maybeHandoffToCodex = (
    reason: AgentTriggerReason,
    sawVisibleOutput: boolean,
  ): boolean =>
    isClaudeCodeAgent &&
    handoffMessageAgentExecutionToCodex({
      activeRole,
      effectiveAgentType,
      hasReviewer: currentLease.reviewer_agent_type !== null,
      reason,
      sawVisibleOutput,
      prompt,
      startSeq,
      endSeq,
      chatJid,
      group,
      pairedTurnIdentity: runtimePairedTurnIdentity,
      markDelegated: () => pairedExecutionLifecycle.markDelegated(),
      log,
    });

  const agentInput = {
    prompt: effectivePrompt,
    sessionId: currentSessionId,
    memoryBriefing,
    groupFolder: group.folder,
    chatJid,
    runId,
    isMain,
    assistantName: deps.assistantName,
    roomRoleContext,
  };

  if (pairedExecutionContext?.blockMessage) {
    pairedExecutionLifecycle.updateSummary({
      outputText: pairedExecutionContext.blockMessage,
    });
    log.warn(
      {
        roomRoleServiceId: roomRoleContext?.serviceId,
        roomRole: roomRoleContext?.role,
      },
      'Blocked paired execution before runner start',
    );
    await onOutput?.({
      status: 'success',
      result: null,
      output: {
        visibility: 'public',
        text: pairedExecutionContext.blockMessage,
      },
      phase: 'final',
    });
    pairedExecutionLifecycle.completeImmediately({ status: 'failed' });
    return 'success';
  }

  const runAttempt = (currentProvider: 'claude' | 'codex') =>
    runMessageAgentAttempt({
      provider: currentProvider,
      currentSessionId,
      isClaudeCodeAgent,
      canRetryClaudeCredentials,
      shouldPersistSession,
      effectiveGroup,
      agentInput,
      activeRole,
      effectiveServiceId,
      effectiveAgentType,
      sessionFolder,
      roomRoleContext,
      pairedExecutionContext,
      fallbackWorkspaceDir: group.workDir ?? null,
      onPersistSession: (sessionId) => {
        deps.persistSession(sessionFolder, sessionId);
        currentSessionId = sessionId;
      },
      registerProcess: (proc, processName, ipcDir) =>
        deps.queue.registerProcess(chatJid, proc, processName, ipcDir),
      onOutput,
      pairedExecutionLifecycle,
      log,
    });

  try {
    return await executeMessageAgentAttemptLifecycle({
      provider,
      runAttempt,
      isClaudeCodeAgent,
      canRetryClaudeCredentials,
      clearStoredSession: () => {
        deps.clearSession(sessionFolder);
        currentSessionId = undefined;
      },
      clearRoleSdkSessions,
      sessionFolder,
      maybeHandoffToCodex,
      hasDirectTerminalDelivery,
      pairedExecutionLifecycle,
      shouldRetryFreshSessionOnAgentFailure,
      rotationLogContext: {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        runId,
      },
      log,
    });
  } finally {
    await pairedExecutionLifecycle.asyncFinalize();
  }
}
