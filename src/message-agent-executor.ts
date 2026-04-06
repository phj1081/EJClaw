import fs from 'fs';
import path from 'path';

import { getErrorMessage } from './utils.js';

import { getAgentOutputText } from './agent-output.js';
import { createEvaluatedOutputHandler } from './agent-attempt.js';
import {
  AgentOutput,
  runAgentProcess,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './agent-runner.js';
import { listAvailableGroups } from './available-groups.js';
import {
  createServiceHandoff,
  getAllTasks,
  getLastHumanMessageSender,
  getLatestOpenPairedTaskForChat,
  getLatestTurnNumber,
  getPairedTaskById,
  insertPairedTurnOutput,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { createScopedLogger } from './logger.js';
import { buildRoomMemoryBriefing } from './sqlite-memory-store.js';
import {
  completePairedExecutionContext,
  preparePairedExecutionContext,
} from './paired-execution-context.js';
import { resolveCodexFallbackHandoff } from './paired-turn-fallback.js';
import { resolveExecutionTarget } from './message-runtime-rules.js';
import {
  isRetryableClaudeSessionFailureAttempt,
  resolveClaudeRetryTrigger,
  resolveCodexRetryTrigger,
  resolvePairedFollowUpQueueAction,
} from './message-agent-executor-rules.js';
import { buildRoomRoleContext } from './room-role-context.js';
import { type AgentTriggerReason } from './agent-error-detection.js';
import {
  runClaudeRotationLoop,
  runCodexRotationLoop,
} from './provider-retry.js';
import {
  shouldResetSessionOnAgentFailure,
  shouldRetryFreshSessionOnAgentFailure,
} from './session-recovery.js';
import {
  ARBITER_AGENT_TYPE,
  CODEX_REVIEW_SERVICE_ID,
  REVIEWER_AGENT_TYPE,
  TIMEZONE,
  isClaudeService,
  getRoleModelConfig,
  getMoaConfig,
} from './config.js';
import { collectMoaReferences, formatMoaReferencesForPrompt } from './moa.js';
import { readArbiterPrompt } from './platform-prompts.js';
import {
  activateCodexFailover,
  getEffectiveChannelLease,
} from './service-routing.js';
import {
  detectCodexRotationTrigger,
  getCodexAccountCount,
} from './codex-token-rotation.js';
import type { CodexRotationReason } from './agent-error-detection.js';
import { getTokenCount } from './token-rotation.js';
import type { AgentType, PairedRoomRole, RegisteredGroup } from './types.js';

// ── Main executor ─────────────────────────────────────────────────

export interface MessageAgentExecutorDeps {
  assistantName: string;
  queue: Pick<GroupQueue, 'registerProcess' | 'enqueueMessageCheck'>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
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
    onOutput?: (output: AgentOutput) => Promise<void>;
  },
): Promise<'success' | 'error'> {
  const { group, prompt, chatJid, runId, startSeq, endSeq, onOutput } = args;
  const isMain = group.isMain === true;
  const sessions = deps.getSessions();

  const currentLease = getEffectiveChannelLease(chatJid);

  // In unified mode, determine role from the lease directly.
  // Default to owner; the auto-review trigger in completePairedExecutionContext
  // will switch to reviewer when the task is in review_ready state.
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
  const unsafeHostPairedMode =
    process.env.EJCLAW_UNSAFE_HOST_PAIRED_MODE === '1';
  const forceFreshClaudeReviewerSession =
    reviewerMode && isClaudeCodeAgent && unsafeHostPairedMode;
  const shouldPersistSession =
    activeRole !== 'arbiter' &&
    !args.forcedAgentType &&
    !forceFreshClaudeReviewerSession;
  const storedSessionId = sessions[sessionFolder];
  if (forceFreshClaudeReviewerSession && storedSessionId) {
    deps.clearSession(sessionFolder);
  }
  // Arbiter always starts fresh — never resume a previous session
  let currentSessionId =
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
    listAvailableGroups(deps.getRegisteredGroups()),
  );

  let resetSessionRequested = false;

  const claudeTokenCount = isClaudeCodeAgent ? getTokenCount() : 0;
  const canRetryClaudeCredentials = isClaudeCodeAgent && claudeTokenCount > 0;
  const canRotateToken = isClaudeCodeAgent && claudeTokenCount > 1;
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
  });
  // Forced fallbacks run under a different agent runtime, so keep the
  // fallback session on its default model/effort unless explicitly configured
  // for that runtime elsewhere.
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

  const log = createScopedLogger({
    chatJid,
    groupName: group.name,
    groupFolder: group.folder,
    runId,
    messageSeqStart: startSeq ?? undefined,
    messageSeqEnd: endSeq ?? undefined,
    role: activeRole,
    serviceId: effectiveServiceId,
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
  let pairedExecutionStatus: 'succeeded' | 'failed' = 'failed';
  let pairedExecutionSummary: string | null = null;
  let pairedFullOutput: string | null = null;
  let pairedExecutionCompleted = false;
  let pairedSawOutput = false;

  const maybeHandoffToCodex = (
    reason: AgentTriggerReason,
    sawVisibleOutput: boolean,
  ): boolean => {
    if (!isClaudeCodeAgent) return false;
    const handoffResolution = resolveCodexFallbackHandoff({
      activeRole,
      effectiveAgentType,
      hasReviewer: currentLease.reviewer_agent_type !== null,
      fallbackEnabled: getRoleModelConfig(activeRole).fallbackEnabled,
      reason,
      sawVisibleOutput,
      prompt,
      startSeq,
      endSeq,
    });

    if (handoffResolution.type === 'none') {
      return false;
    }

    if (handoffResolution.type === 'skip') {
      log.info({ reason }, handoffResolution.logMessage);
      return false;
    }

    if (handoffResolution.plan.activateOwnerFailoverReason) {
      activateCodexFailover(
        chatJid,
        handoffResolution.plan.activateOwnerFailoverReason,
      );
    }
    createServiceHandoff({
      chat_jid: chatJid,
      group_folder: group.folder,
      ...handoffResolution.plan.handoff,
    });
    log.warn({ reason }, handoffResolution.plan.logMessage);
    return true;
  };

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
    pairedExecutionSummary = pairedExecutionContext.blockMessage.slice(0, 500);
    log.warn(
      {
        roomRoleServiceId: roomRoleContext?.serviceId,
        roomRole: roomRoleContext?.role,
      },
      'Blocked reviewer execution before review-ready snapshot was available',
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
    completePairedExecutionContext({
      taskId: pairedExecutionContext.task.id,
      role: roomRoleContext?.role ?? 'owner',
      status: pairedExecutionStatus,
      summary: pairedExecutionSummary,
    });
    pairedExecutionCompleted = true;
    return 'success';
  }

  const runAttempt = async (
    provider: string,
  ): Promise<{
    output?: AgentOutput;
    error?: unknown;
    sawOutput: boolean;
    sawVisibleOutput: boolean;
    sawSuccessNullResultWithoutOutput: boolean;
    retryableSessionFailureDetected: boolean;
    streamedTriggerReason?: {
      reason: AgentTriggerReason;
      retryAfterMs?: number;
    };
  }> => {
    const attemptSessionId = currentSessionId;
    const streamedOutputHandler = createEvaluatedOutputHandler({
      agentType: isClaudeCodeAgent ? 'claude-code' : 'codex',
      provider,
      evaluationOptions: {
        suppressClaudeAuthErrorOutput: provider === 'claude',
        trackSuccessNullResult: true,
        shortCircuitTriggeredErrors:
          provider === 'claude'
            ? canRetryClaudeCredentials
            : getCodexAccountCount() > 1,
      },
      onEvaluatedOutput: async ({
        output,
        outputText,
        structuredOutput,
        evaluation,
      }) => {
        const outputPhase = output.phase ?? 'final';
        if (outputPhase !== 'final') {
          log.info(
            {
              provider,
              outputPhase,
              outputStatus: output.status,
              visibility: structuredOutput?.visibility ?? null,
              preview:
                outputText && outputText.length > 0
                  ? outputText.slice(0, 160)
                  : null,
              errorPreview:
                typeof output.error === 'string' && output.error.length > 0
                  ? output.error.slice(0, 160)
                  : null,
              activeRole,
              effectiveServiceId,
              effectiveAgentType,
              sessionFolder,
              resumedSession: attemptSessionId ?? null,
              streamedSessionId: output.newSessionId ?? null,
              roomRoleServiceId: roomRoleContext?.serviceId ?? null,
              roomRole: roomRoleContext?.role ?? null,
              pairedTaskId: pairedExecutionContext?.task.id ?? null,
              workspaceDir:
                pairedExecutionContext?.workspace?.workspace_dir ??
                group.workDir ??
                null,
            },
            'Observed streamed agent activity',
          );
        }
        if (
          isClaudeCodeAgent &&
          provider === 'claude' &&
          shouldResetSessionOnAgentFailure(output)
        ) {
          resetSessionRequested = true;
        }
        if (
          output.newSessionId &&
          !resetSessionRequested &&
          shouldPersistSession
        ) {
          deps.persistSession(sessionFolder, output.newSessionId);
          currentSessionId = output.newSessionId;
        }

        if (outputText && outputText.length > 0) {
          pairedExecutionSummary = outputText.slice(0, 500);
          pairedFullOutput = outputText;
        } else if (
          typeof output.error === 'string' &&
          output.error.length > 0
        ) {
          pairedExecutionSummary = output.error.slice(0, 500);
        }
        if (
          evaluation.newTrigger &&
          outputText &&
          output.status === 'success'
        ) {
          log.warn(
            {
              reason: evaluation.newTrigger.reason,
              resultPreview: outputText.slice(0, 120),
            },
            'Detected Claude rotation trigger in successful output',
          );
        } else if (evaluation.newTrigger && typeof output.error === 'string') {
          log.warn(
            {
              reason: evaluation.newTrigger.reason,
              errorPreview: output.error.slice(0, 120),
            },
            provider === 'claude'
              ? 'Detected Claude rotation trigger in streamed error output'
              : 'Detected Codex rotation trigger in streamed error output',
          );
        }

        if (evaluation.suppressedAuthError) {
          log.warn(
            {
              resultPreview: outputText ? outputText.slice(0, 120) : undefined,
            },
            'Suppressed Claude 401 auth error from chat output',
          );
          return;
        }

        if (evaluation.suppressedRetryableSessionFailure) {
          log.warn(
            {
              resultPreview: outputText
                ? outputText.slice(0, 160)
                : output.error?.slice(0, 160),
            },
            'Suppressed retryable Claude session failure from chat output',
          );
          return;
        }

        if (!evaluation.shouldForwardOutput) {
          return;
        }
        if (outputText && outputText.length > 0) {
          streamedOutputHandler.markVisibleOutput();
        }
        if (onOutput) {
          await onOutput(output);
        }
      },
    });

    const wrappedOnOutput = async (output: AgentOutput) => {
      await streamedOutputHandler.handleOutput(output);
    };

    const providerLog = log.child({
      provider,
      agentType: effectiveAgentType,
    });
    providerLog.info('Using provider');

    try {
      const output = await runAgentProcess(
        effectiveGroup,
        {
          ...agentInput,
          sessionId: attemptSessionId,
        },
        (proc, processName, ipcDir) =>
          deps.queue.registerProcess(chatJid, proc, processName, ipcDir),
        wrappedOnOutput,
        pairedExecutionContext?.envOverrides,
      );

      if (output.newSessionId && shouldPersistSession) {
        deps.persistSession(sessionFolder, output.newSessionId);
        currentSessionId = output.newSessionId;
      }

      providerLog.info(
        {
          status: output.status,
          sawOutput: streamedOutputHandler.getState().sawOutput,
        },
        `Provider response completed (provider: ${provider})`,
      );

      const streamedState = streamedOutputHandler.getState();
      return {
        output,
        sawOutput: streamedState.sawOutput,
        sawVisibleOutput: streamedState.sawVisibleOutput,
        sawSuccessNullResultWithoutOutput:
          streamedState.sawSuccessNullResultWithoutOutput,
        retryableSessionFailureDetected:
          streamedState.retryableSessionFailureDetected === true,
        streamedTriggerReason: streamedState.streamedTriggerReason,
      };
    } catch (error) {
      const streamedState = streamedOutputHandler.getState();
      return {
        error,
        sawOutput: streamedState.sawOutput,
        sawVisibleOutput: streamedState.sawVisibleOutput,
        sawSuccessNullResultWithoutOutput:
          streamedState.sawSuccessNullResultWithoutOutput,
        retryableSessionFailureDetected:
          streamedState.retryableSessionFailureDetected === true,
        streamedTriggerReason: streamedState.streamedTriggerReason,
      };
    }
  };

  const retryCodexWithRotation = async (
    initialTrigger: { reason: CodexRotationReason },
    rotationMessage?: string,
  ): Promise<'success' | 'error'> => {
    const outcome = await runCodexRotationLoop(
      initialTrigger,
      async () => {
        const attempt = await runAttempt('codex');
        return {
          output: attempt.output,
          thrownError: attempt.error,
          sawOutput: attempt.sawOutput,
          streamedTriggerReason: attempt.streamedTriggerReason,
        };
      },
      {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        runId,
      },
      rotationMessage,
    );

    return outcome.type === 'success' ? 'success' : 'error';
  };

  type AgentAttempt = Awaited<ReturnType<typeof runAttempt>>;

  const retryClaudeWithRotation = async (
    initialTrigger: {
      reason: AgentTriggerReason;
      retryAfterMs?: number;
    },
    rotationMessage?: string,
  ): Promise<'success' | 'error'> => {
    const logCtx = {
      chatJid,
      group: group.name,
      groupFolder: group.folder,
      runId,
    };

    const outcome = await runClaudeRotationLoop(
      initialTrigger,
      async () => {
        const attempt = await runAttempt('claude');
        return {
          output: attempt.output,
          thrownError: attempt.error,
          sawOutput: attempt.sawOutput,
          sawSuccessNullResult: attempt.sawSuccessNullResultWithoutOutput,
          streamedTriggerReason: attempt.streamedTriggerReason,
        };
      },
      logCtx,
      rotationMessage,
    );

    switch (outcome.type) {
      case 'success':
        pairedSawOutput = outcome.sawOutput;
        return 'success';
      case 'error':
        return 'error';
    }
  };

  const retryClaudeAttemptIfNeeded = async (
    attempt: AgentAttempt,
    rotationMessage?: string | null,
  ): Promise<'success' | 'error' | null> => {
    const trigger = resolveClaudeRetryTrigger({
      canRetryClaudeCredentials,
      provider,
      attempt,
      fallbackMessage: rotationMessage,
    });
    if (!trigger) {
      return null;
    }

    const result = await retryClaudeWithRotation(
      trigger,
      rotationMessage ?? undefined,
    );
    if (result === 'error') {
      return maybeHandoffAfterError(trigger.reason, attempt);
    }

    pairedExecutionStatus = 'succeeded';
    return result;
  };

  const retryCodexAttemptIfNeeded = async (
    attempt: AgentAttempt,
    rotationMessage?: string | null,
  ): Promise<'success' | 'error' | null> => {
    const trigger = resolveCodexRetryTrigger({
      canRetryCodex: !isClaudeCodeAgent && getCodexAccountCount() > 1,
      attempt,
      rotationMessage,
    });
    if (!trigger) {
      return null;
    }

    const result = await retryCodexWithRotation(
      { reason: trigger.reason },
      rotationMessage ?? undefined,
    );
    if (result === 'success') {
      pairedExecutionStatus = 'succeeded';
    }
    return result;
  };

  const maybeHandoffAfterError = (
    reason: AgentTriggerReason,
    attempt: AgentAttempt,
  ): 'success' | 'error' => {
    if (maybeHandoffToCodex(reason, attempt.sawVisibleOutput)) {
      return 'success';
    }
    return 'error';
  };

  const getPairedExecutionStatus = (): 'succeeded' | 'failed' =>
    pairedExecutionStatus;

  const isRetryableClaudeSessionFailure = (attempt: AgentAttempt): boolean =>
    isRetryableClaudeSessionFailureAttempt({
      attempt,
      isClaudeCodeAgent,
      provider,
      shouldRetryFreshSessionOnAgentFailure,
    });

  const recoverRetryableClaudeSessionFailure = async (
    attempt: AgentAttempt,
  ): Promise<{
    attempt: AgentAttempt;
    resolved: 'success' | 'error' | null;
  }> => {
    if (!isRetryableClaudeSessionFailure(attempt)) {
      return { attempt, resolved: null };
    }

    currentSessionId = undefined;
    deps.clearSession(sessionFolder);
    clearRoleSdkSessions();
    log.warn(
      'Cleared poisoned Claude session before visible output, retrying fresh session',
    );

    const freshAttempt = await runAttempt('claude');
    if (!isRetryableClaudeSessionFailure(freshAttempt)) {
      return { attempt: freshAttempt, resolved: null };
    }

    currentSessionId = undefined;
    deps.clearSession(sessionFolder);
    log.warn('Fresh Claude retry also hit a retryable session failure');
    log.error('Retryable Claude session failure persisted after fresh retry');
    return {
      attempt: freshAttempt,
      resolved: maybeHandoffAfterError('session-failure', freshAttempt),
    };
  };

  const handlePrimaryAttemptFailure = async (
    attempt: AgentAttempt,
    rotationMessage: string,
  ): Promise<'success' | 'error'> => {
    const claudeRetryResult = await retryClaudeAttemptIfNeeded(
      attempt,
      rotationMessage,
    );
    if (claudeRetryResult) {
      return claudeRetryResult;
    }

    const codexRetryResult = await retryCodexAttemptIfNeeded(
      attempt,
      rotationMessage,
    );
    if (codexRetryResult) {
      return codexRetryResult;
    }

    if (attempt.error) {
      log.error(
        {
          provider,
          err: attempt.error,
        },
        'Agent error',
      );
      return 'error';
    }

    log.error(
      {
        provider,
        error: attempt.output?.error,
      },
      'Agent process error',
    );
    return 'error';
  };

  const finalizePrimaryAttempt = async (
    attempt: AgentAttempt,
  ): Promise<'success' | 'error'> => {
    const output = attempt.output;
    if (!output) {
      log.error({ provider }, 'Agent produced no output object');
      return 'error';
    }

    if (!pairedExecutionSummary) {
      const finalOutputText = getAgentOutputText(output);
      pairedExecutionSummary =
        (typeof finalOutputText === 'string' && finalOutputText.length > 0
          ? finalOutputText.slice(0, 500)
          : null) ??
        (typeof output.error === 'string' && output.error.length > 0
          ? output.error.slice(0, 500)
          : null);
    }

    if (!attempt.sawOutput && output.status !== 'error') {
      const claudeRetryResult = await retryClaudeAttemptIfNeeded(attempt);
      if (claudeRetryResult) {
        return claudeRetryResult;
      }
    }

    if (
      isClaudeCodeAgent &&
      (resetSessionRequested || shouldResetSessionOnAgentFailure(output))
    ) {
      deps.clearSession(sessionFolder);
      log.warn(
        { sessionFolder },
        'Cleared poisoned agent session after unrecoverable error',
      );
    }

    if (output.status === 'error') {
      return handlePrimaryAttemptFailure(
        attempt,
        output.error ?? 'Agent process error',
      );
    }

    const codexRetryResult = await retryCodexAttemptIfNeeded(
      attempt,
      output.error ?? output.result,
    );
    if (codexRetryResult) {
      return codexRetryResult;
    }

    // Unresolved streamed trigger — rotation was unavailable or output was
    // already forwarded. Surfaces as an error since there is no alternative provider.
    if (attempt.streamedTriggerReason) {
      if (
        isClaudeCodeAgent &&
        maybeHandoffToCodex(
          attempt.streamedTriggerReason.reason,
          attempt.sawVisibleOutput,
        )
      ) {
        return 'success';
      }
      log.error(
        {
          reason: attempt.streamedTriggerReason.reason,
        },
        'Agent trigger detected but could not be resolved',
      );
      return 'error';
    }

    // success-null-result with no visible output — agent returned nothing useful.
    // But if output was already delivered to Discord (sawOutput), treat as success.
    if (attempt.sawSuccessNullResultWithoutOutput && !attempt.sawOutput) {
      log.error(
        'Agent returned success with null result and no visible output',
      );
      return 'error';
    }

    pairedExecutionStatus = 'succeeded';
    pairedSawOutput = attempt.sawOutput;
    return 'success';
  };

  try {
    let primaryAttempt = await runAttempt(provider);
    const recoveredSessionAttempt =
      await recoverRetryableClaudeSessionFailure(primaryAttempt);
    if (recoveredSessionAttempt.resolved) {
      return recoveredSessionAttempt.resolved;
    }
    primaryAttempt = recoveredSessionAttempt.attempt;

    if (primaryAttempt.error) {
      return await handlePrimaryAttemptFailure(
        primaryAttempt,
        getErrorMessage(primaryAttempt.error),
      );
    }

    return await finalizePrimaryAttempt(primaryAttempt);
  } finally {
    if (pairedExecutionContext && !pairedExecutionCompleted) {
      const completedRole = roomRoleContext?.role ?? 'owner';
      const completionStatus = getPairedExecutionStatus();
      // Owner was interrupted without producing output (e.g. /stop) —
      // treat as failed so reviewer is not auto-triggered.
      const effectiveStatus =
        completedRole === 'owner' &&
        completionStatus === 'succeeded' &&
        !pairedSawOutput
          ? 'failed'
          : completionStatus;
      completePairedExecutionContext({
        taskId: pairedExecutionContext.task.id,
        role: completedRole,
        status: effectiveStatus,
        summary: pairedExecutionSummary,
      });

      // Store full output for direct inter-agent data passing (Discord-independent).
      if (pairedFullOutput && effectiveStatus === 'succeeded') {
        try {
          const turnNumber =
            getLatestTurnNumber(pairedExecutionContext.task.id) + 1;
          insertPairedTurnOutput(
            pairedExecutionContext.task.id,
            turnNumber,
            completedRole,
            pairedFullOutput,
          );
        } catch (err) {
          log.warn(
            { pairedTaskId: pairedExecutionContext.task.id, err },
            'Failed to store paired turn output',
          );
        }
      }
    }

    // Notify user when paired task reaches a terminal state that requires attention.
    if (pairedExecutionContext) {
      const finishedTask = getPairedTaskById(pairedExecutionContext.task.id);
      if (
        finishedTask?.status === 'completed' &&
        finishedTask.completion_reason
      ) {
        const sender = getLastHumanMessageSender(chatJid);
        const mention = sender ? `<@${sender}>` : '';
        const notifications: Record<string, string> = {
          done: `${mention} ✅ 작업 완료.`,
          escalated: `${mention} ⚠️ 자동 해결 불가 — 확인이 필요합니다.`,
          arbiter_escalated: `${mention} ⚠️ 중재자 판단: 사람 개입이 필요합니다.`,
        };
        const message = notifications[finishedTask.completion_reason];
        if (message) {
          await args.onOutput?.({
            status: 'success',
            result: message,
            output: { visibility: 'public', text: message },
            phase: 'final',
          });
        }
      }
    }

    // After owner/reviewer completes, enqueue the next turn so
    // the message loop picks it up without waiting for a new message.
    // Skip if: no output (interrupted), or task already completed (ESCALATE, done, etc.)
    if (pairedExecutionContext) {
      const completedRole = roomRoleContext?.role ?? 'owner';
      const finishedCheck = getPairedTaskById(pairedExecutionContext.task.id);
      const queueAction = resolvePairedFollowUpQueueAction({
        completedRole,
        executionStatus: pairedExecutionStatus,
        sawOutput: pairedSawOutput,
        taskStatus: finishedCheck?.status ?? null,
      });
      if (queueAction === 'generic') {
        deps.queue.enqueueMessageCheck(chatJid);
      } else if (queueAction === 'skip-inline-finalize') {
        log.info(
          {
            taskId: pairedExecutionContext.task.id,
            role: completedRole,
            taskStatus: finishedCheck?.status ?? null,
          },
          'Skipping generic follow-up after reviewer approval because inline finalize will handle the owner handoff',
        );
      } else if (queueAction === 'pending') {
        deps.queue.enqueueMessageCheck(chatJid);
        log.info(
          {
            taskId: pairedExecutionContext.task.id,
            role: completedRole,
            pairedExecutionStatus,
            taskStatus: finishedCheck?.status ?? null,
          },
          'Queued paired follow-up after failed reviewer/arbiter execution left a pending task state',
        );
      }
    }
  }
}
