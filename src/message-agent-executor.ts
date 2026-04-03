import { getErrorMessage } from './utils.js';

import {
  getAgentOutputText,
  getStructuredAgentOutput,
} from './agent-output.js';
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
import {
  resolveActiveRole,
  resolveConfiguredRoleAgentPlan,
  resolveEffectiveAgentType,
  resolveSessionFolder,
} from './message-runtime-rules.js';
import { buildRoomRoleContext } from './room-role-context.js';
import {
  classifyRotationTrigger,
  type AgentTriggerReason,
} from './agent-error-detection.js';
import { runClaudeRotationLoop } from './provider-retry.js';
import {
  shouldResetSessionOnAgentFailure,
  shouldRetryFreshSessionOnAgentFailure,
} from './session-recovery.js';
import {
  ARBITER_AGENT_TYPE,
  CODEX_REVIEW_SERVICE_ID,
  REVIEWER_AGENT_TYPE,
  SERVICE_SESSION_SCOPE,
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
  resolveLeaseServiceId,
} from './service-routing.js';
import {
  evaluateStreamedOutput,
  type StreamedOutputState,
} from './streamed-output-evaluator.js';
import {
  detectCodexRotationTrigger,
  rotateCodexToken,
  getCodexAccountCount,
  markCodexTokenHealthy,
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
  const inferredRole = resolveActiveRole(pairedTask?.status);
  const canHonorForcedRole = Boolean(
    args.forcedRole === 'owner' ||
    (args.forcedRole === 'reviewer' && currentLease.reviewer_agent_type) ||
    (args.forcedRole === 'arbiter' && currentLease.arbiter_agent_type),
  );
  const activeRole = canHonorForcedRole ? args.forcedRole! : inferredRole;
  const effectiveServiceId = resolveLeaseServiceId(currentLease, activeRole);
  if (!effectiveServiceId) {
    throw new Error(`Missing runtime service id for ${activeRole} lease`);
  }
  const reviewerMode = activeRole === 'reviewer';
  const arbiterMode = activeRole === 'arbiter';
  const reviewerServiceId = resolveLeaseServiceId(currentLease, 'reviewer');
  const arbiterServiceId = resolveLeaseServiceId(currentLease, 'arbiter');
  const roleAgentPlan = resolveConfiguredRoleAgentPlan(
    currentLease.reviewer_agent_type != null,
    group.agentType,
  );

  const configuredAgentType = resolveEffectiveAgentType(
    activeRole,
    group.agentType,
  );
  const effectiveAgentType = args.forcedAgentType ?? configuredAgentType;
  const effectiveGroup =
    effectiveAgentType !== roleAgentPlan.ownerAgentType
      ? { ...group, agentType: effectiveAgentType }
      : group;
  const isClaudeCodeAgent = effectiveAgentType === 'claude-code';
  const sessionFolder = resolveSessionFolder(
    group.folder,
    activeRole,
    group.agentType,
  );
  // Arbiter always starts fresh — never resume a previous session
  const sessionId =
    activeRole === 'arbiter' || args.forcedAgentType
      ? undefined
      : sessions[sessionFolder];
  const memoryBriefing = sessionId
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

  const canRotateToken = isClaudeCodeAgent && getTokenCount() > 1;
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
      resumedSession: sessionId ?? null,
    },
    'Resolved execution target for agent turn',
  );

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
  }

  const effectivePrompt = moaEnrichedPrompt;
  let pairedExecutionStatus: 'succeeded' | 'failed' = 'failed';
  let pairedExecutionSummary: string | null = null;
  let pairedFullOutput: string | null = null;
  let pairedExecutionCompleted = false;
  let pairedSawOutput = false;

  const shouldHandoffToCodex = (
    reason: AgentTriggerReason,
    sawVisibleOutput: boolean,
  ): boolean => {
    if (sawVisibleOutput) {
      return false;
    }
    return (
      reason === '429' ||
      reason === 'usage-exhausted' ||
      reason === 'auth-expired' ||
      reason === 'org-access-denied' ||
      reason === 'session-failure'
    );
  };

  const maybeHandoffToCodex = (
    reason: AgentTriggerReason,
    sawVisibleOutput: boolean,
  ): boolean => {
    if (!isClaudeCodeAgent) return false;
    if (!shouldHandoffToCodex(reason, sawVisibleOutput)) {
      return false;
    }
    if (currentLease.reviewer_agent_type === null) {
      return false;
    }
    // Per-role fallback toggle
    const roleConfig = getRoleModelConfig(activeRole);
    if (!roleConfig.fallbackEnabled) {
      log.info({ reason }, 'Fallback disabled for role, skipping handoff');
      return false;
    }

    if (arbiterMode) {
      // Arbiter failed (e.g. Claude 401/429) — re-trigger arbitration with codex
      createServiceHandoff({
        chat_jid: chatJid,
        group_folder: group.folder,
        source_role: activeRole,
        target_role: 'arbiter',
        source_agent_type: effectiveAgentType,
        target_agent_type: 'codex',
        prompt,
        start_seq: startSeq ?? null,
        end_seq: endSeq ?? null,
        reason: `arbiter-claude-${reason}`,
        intended_role: 'arbiter',
      });
      log.warn(
        { reason },
        'Claude arbiter unavailable, handed off arbiter turn to codex',
      );
      return true;
    }

    if (reviewerMode) {
      // Reviewer failed (e.g. Claude 401/429) — re-trigger review with codex
      // instead of swapping owner/reviewer roles.
      createServiceHandoff({
        chat_jid: chatJid,
        group_folder: group.folder,
        source_role: activeRole,
        target_role: 'reviewer',
        source_agent_type: effectiveAgentType,
        target_agent_type: 'codex',
        prompt,
        start_seq: startSeq ?? null,
        end_seq: endSeq ?? null,
        reason: `reviewer-claude-${reason}`,
        intended_role: 'reviewer',
      });
      log.warn(
        { reason },
        'Claude reviewer unavailable, handed off review turn to codex-review',
      );
      return true;
    }

    activateCodexFailover(chatJid, `claude-${reason}`);
    createServiceHandoff({
      chat_jid: chatJid,
      group_folder: group.folder,
      source_role: activeRole,
      target_role: activeRole,
      source_agent_type: effectiveAgentType,
      target_agent_type: 'codex',
      prompt,
      start_seq: startSeq ?? null,
      end_seq: endSeq ?? null,
      reason: `claude-${reason}`,
      intended_role: activeRole,
    });
    log.warn(
      { reason },
      'Claude unavailable, handed off current owner turn to codex fallback',
    );
    return true;
  };

  const agentInput = {
    prompt: effectivePrompt,
    sessionId,
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
    let streamedState: StreamedOutputState = {
      sawOutput: false,
      sawVisibleOutput: false,
      sawSuccessNullResultWithoutOutput: false,
    };

    const wrappedOnOutput = onOutput
      ? async (output: AgentOutput) => {
          const outputPhase = output.phase ?? 'final';
          const outputText = getAgentOutputText(output);
          const structuredOutput = getStructuredAgentOutput(output);
          if (outputPhase !== 'final') {
            log.info(
              {
                provider,
                outputPhase,
                outputStatus: output.status,
                visibility: structuredOutput?.visibility ?? null,
                preview:
                  typeof outputText === 'string' && outputText.length > 0
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
                resumedSession: sessionId ?? null,
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
            provider === 'claude' &&
            output.newSessionId &&
            !resetSessionRequested
          ) {
            deps.persistSession(sessionFolder, output.newSessionId);
          }
          const evaluation = evaluateStreamedOutput(output, streamedState, {
            agentType: isClaudeCodeAgent ? 'claude-code' : 'codex',
            provider,
            suppressClaudeAuthErrorOutput: provider === 'claude',
            trackSuccessNullResult: true,
            shortCircuitTriggeredErrors:
              provider === 'claude'
                ? canRotateToken
                : getCodexAccountCount() > 1,
          });
          streamedState = evaluation.state;

          if (typeof outputText === 'string' && outputText.length > 0) {
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
            typeof outputText === 'string' &&
            output.status === 'success'
          ) {
            log.warn(
              {
                reason: evaluation.newTrigger.reason,
                resultPreview: outputText.slice(0, 120),
              },
              'Detected Claude rotation trigger in successful output',
            );
          } else if (
            evaluation.newTrigger &&
            typeof output.error === 'string'
          ) {
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
                resultPreview:
                  typeof outputText === 'string'
                    ? outputText.slice(0, 120)
                    : undefined,
              },
              'Suppressed Claude 401 auth error from chat output',
            );
            return;
          }

          if (evaluation.suppressedRetryableSessionFailure) {
            log.warn(
              {
                resultPreview:
                  typeof outputText === 'string'
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
          if (typeof outputText === 'string' && outputText.length > 0) {
            streamedState = {
              ...evaluation.state,
              sawVisibleOutput: true,
            };
          }
          await onOutput(output);
        }
      : undefined;

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
          sessionId: provider === 'claude' ? sessionId : undefined,
        },
        (proc, processName, ipcDir) =>
          deps.queue.registerProcess(chatJid, proc, processName, ipcDir),
        wrappedOnOutput,
        pairedExecutionContext?.envOverrides,
      );

      if (provider === 'claude' && output.newSessionId) {
        deps.persistSession(sessionFolder, output.newSessionId);
      }

      providerLog.info(
        {
          status: output.status,
          sawOutput: streamedState.sawOutput,
        },
        `Provider response completed (provider: ${provider})`,
      );

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
    let trigger = initialTrigger;
    let lastRotationMessage = rotationMessage;

    while (
      getCodexAccountCount() > 1 &&
      rotateCodexToken(lastRotationMessage)
    ) {
      log.info(
        { reason: trigger.reason },
        'Codex account unhealthy, retrying with rotated account',
      );

      const retryAttempt = await runAttempt('codex');

      if (retryAttempt.error) {
        const errMsg = getErrorMessage(retryAttempt.error);
        const retryTrigger = detectCodexRotationTrigger(errMsg);
        if (retryTrigger.shouldRotate) {
          trigger = { reason: retryTrigger.reason };
          lastRotationMessage = errMsg;
          continue;
        }

        log.error(
          { provider: 'codex', err: retryAttempt.error },
          'Rotated Codex account also threw',
        );
        return 'error';
      }

      const retryOutput = retryAttempt.output;
      if (!retryOutput) {
        log.error(
          { provider: 'codex' },
          'Rotated Codex account produced no output object',
        );
        return 'error';
      }

      if (
        !retryAttempt.sawOutput &&
        retryAttempt.streamedTriggerReason &&
        retryOutput.status !== 'error'
      ) {
        trigger = {
          reason: retryAttempt.streamedTriggerReason
            .reason as CodexRotationReason,
        };
        lastRotationMessage =
          typeof retryOutput.result === 'string'
            ? retryOutput.result
            : undefined;
        continue;
      }

      if (retryOutput.status === 'error') {
        const retryTrigger = retryAttempt.streamedTriggerReason
          ? {
              shouldRotate: true,
              reason: retryAttempt.streamedTriggerReason
                .reason as CodexRotationReason,
            }
          : detectCodexRotationTrigger(retryOutput.error);

        if (retryTrigger.shouldRotate) {
          trigger = { reason: retryTrigger.reason };
          lastRotationMessage = retryOutput.error ?? undefined;
          continue;
        }

        log.error(
          {
            provider: 'codex',
            error: retryOutput.error,
          },
          'Rotated Codex account failed',
        );
        return 'error';
      }

      markCodexTokenHealthy();
      return 'success';
    }

    return 'error';
  };

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

  const maybeHandoffAfterError = (
    reason: AgentTriggerReason,
    attempt: Awaited<ReturnType<typeof runAttempt>>,
  ): 'success' | 'error' => {
    if (maybeHandoffToCodex(reason, attempt.sawVisibleOutput)) {
      return 'success';
    }
    return 'error';
  };

  const provider = 'claude';

  try {
    let primaryAttempt = await runAttempt(provider);

    const isRetryableClaudeSessionFailure = (
      attempt: Awaited<ReturnType<typeof runAttempt>>,
    ): boolean =>
      isClaudeCodeAgent &&
      provider === 'claude' &&
      !attempt.sawOutput &&
      (attempt.retryableSessionFailureDetected === true ||
        (attempt.error != null &&
          shouldRetryFreshSessionOnAgentFailure({
            result: null,
            error: getErrorMessage(attempt.error),
          })));

    if (isRetryableClaudeSessionFailure(primaryAttempt)) {
      deps.clearSession(sessionFolder);
      log.warn(
        'Cleared poisoned Claude session before visible output, retrying fresh session',
      );

      primaryAttempt = await runAttempt('claude');

      if (isRetryableClaudeSessionFailure(primaryAttempt)) {
        deps.clearSession(sessionFolder);
        log.warn('Fresh Claude retry also hit a retryable session failure');

        log.error(
          'Retryable Claude session failure persisted after fresh retry',
        );
        return maybeHandoffAfterError('session-failure', primaryAttempt);
      }
    }

    if (primaryAttempt.error) {
      if (
        canRotateToken &&
        provider === 'claude' &&
        !primaryAttempt.sawOutput
      ) {
        const errMsg = getErrorMessage(primaryAttempt.error);
        const trigger = primaryAttempt.streamedTriggerReason
          ? {
              shouldRetry: true,
              reason: primaryAttempt.streamedTriggerReason.reason,
              retryAfterMs: primaryAttempt.streamedTriggerReason.retryAfterMs,
            }
          : classifyRotationTrigger(errMsg);
        if (trigger.shouldRetry) {
          const result = await retryClaudeWithRotation(
            {
              reason: trigger.reason,
              retryAfterMs: trigger.retryAfterMs,
            },
            errMsg,
          );
          if (result === 'error') {
            return maybeHandoffAfterError(trigger.reason, primaryAttempt);
          }
          if (result === 'success') {
            pairedExecutionStatus = 'succeeded';
          }
          return result;
        }
      }

      if (!isClaudeCodeAgent) {
        const errMsg = getErrorMessage(primaryAttempt.error);
        const trigger = detectCodexRotationTrigger(errMsg);
        if (trigger.shouldRotate && getCodexAccountCount() > 1) {
          const result = await retryCodexWithRotation(
            { reason: trigger.reason },
            errMsg,
          );
          if (result === 'success') {
            pairedExecutionStatus = 'succeeded';
          }
          return result;
        }
      }

      log.error(
        {
          provider,
          err: primaryAttempt.error,
        },
        'Agent error',
      );
      return 'error';
    }

    const output = primaryAttempt.output;
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

    if (
      canRotateToken &&
      provider === 'claude' &&
      !primaryAttempt.sawOutput &&
      primaryAttempt.streamedTriggerReason &&
      output.status !== 'error'
    ) {
      const result = await retryClaudeWithRotation({
        reason: primaryAttempt.streamedTriggerReason.reason,
        retryAfterMs: primaryAttempt.streamedTriggerReason.retryAfterMs,
      });
      if (result === 'error') {
        return maybeHandoffAfterError(
          primaryAttempt.streamedTriggerReason.reason,
          primaryAttempt,
        );
      }
      return result;
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
      if (
        canRotateToken &&
        provider === 'claude' &&
        !primaryAttempt.sawOutput
      ) {
        const trigger = primaryAttempt.streamedTriggerReason
          ? {
              shouldRetry: true,
              reason: primaryAttempt.streamedTriggerReason.reason,
              retryAfterMs: primaryAttempt.streamedTriggerReason.retryAfterMs,
            }
          : classifyRotationTrigger(output.error);
        if (trigger.shouldRetry) {
          const result = await retryClaudeWithRotation(
            {
              reason: trigger.reason,
              retryAfterMs: trigger.retryAfterMs,
            },
            output.error ?? undefined,
          );
          if (result === 'error') {
            return maybeHandoffAfterError(trigger.reason, primaryAttempt);
          }
          if (result === 'success') {
            pairedExecutionStatus = 'succeeded';
          }
          return result;
        }
      }

      if (!isClaudeCodeAgent && getCodexAccountCount() > 1) {
        const trigger = detectCodexRotationTrigger(output.error);
        if (trigger.shouldRotate) {
          const result = await retryCodexWithRotation(
            { reason: trigger.reason },
            output.error ?? undefined,
          );
          if (result === 'success') {
            pairedExecutionStatus = 'succeeded';
          }
          return result;
        }
      }

      log.error(
        {
          provider,
          error: output.error,
        },
        'Agent process error',
      );
      return 'error';
    }

    if (
      !isClaudeCodeAgent &&
      primaryAttempt.streamedTriggerReason &&
      getCodexAccountCount() > 1
    ) {
      const result = await retryCodexWithRotation(
        {
          reason: primaryAttempt.streamedTriggerReason
            .reason as CodexRotationReason,
        },
        output.error ?? output.result ?? undefined,
      );
      if (result === 'success') {
        pairedExecutionStatus = 'succeeded';
      }
      return result;
    }

    // Unresolved streamed trigger — rotation was unavailable or output was
    // already forwarded.  Surfaces as an error since there is no alternative provider.
    if (primaryAttempt.streamedTriggerReason) {
      if (
        isClaudeCodeAgent &&
        maybeHandoffToCodex(
          primaryAttempt.streamedTriggerReason.reason,
          primaryAttempt.sawVisibleOutput,
        )
      ) {
        return 'success';
      }
      log.error(
        {
          reason: primaryAttempt.streamedTriggerReason.reason,
        },
        'Agent trigger detected but could not be resolved',
      );
      return 'error';
    }

    // success-null-result with no visible output — agent returned nothing useful.
    // But if output was already delivered to Discord (sawOutput), treat as success.
    if (
      primaryAttempt.sawSuccessNullResultWithoutOutput &&
      !primaryAttempt.sawOutput
    ) {
      log.error(
        'Agent returned success with null result and no visible output',
      );
      return 'error';
    }

    pairedExecutionStatus = 'succeeded';
    pairedSawOutput = primaryAttempt.sawOutput;
    return 'success';
  } finally {
    if (pairedExecutionContext && !pairedExecutionCompleted) {
      const completedRole = roomRoleContext?.role ?? 'owner';
      // Owner was interrupted without producing output (e.g. /stop) —
      // treat as failed so reviewer is not auto-triggered.
      const effectiveStatus =
        completedRole === 'owner' &&
        pairedExecutionStatus === 'succeeded' &&
        !pairedSawOutput
          ? 'failed'
          : pairedExecutionStatus;
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
    if (
      pairedExecutionContext &&
      pairedExecutionStatus === 'succeeded' &&
      pairedSawOutput
    ) {
      const finishedCheck = getPairedTaskById(pairedExecutionContext.task.id);
      if (finishedCheck?.status !== 'completed') {
        deps.queue.enqueueMessageCheck(chatJid);
      }
    }
  }
}
