import { getErrorMessage } from './utils.js';

import {
  AgentOutput,
  runAgentProcess,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './agent-runner.js';
import { listAvailableGroups } from './available-groups.js';
import { createServiceHandoff, getAllTasks } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { buildRoomMemoryBriefing } from './memento-client.js';
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
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  SERVICE_SESSION_SCOPE,
} from './config.js';
import {
  buildSuppressTokenPrompt,
  classifySuppressTokenOutput,
} from './output-suppression.js';
import {
  activateCodexFailover,
  getEffectiveChannelLease,
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
import type { RegisteredGroup } from './types.js';

// ── Main executor ─────────────────────────────────────────────────

export interface MessageAgentExecutorDeps {
  assistantName: string;
  queue: Pick<GroupQueue, 'registerProcess'>;
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
    suppressToken?: string;
    startSeq?: number | null;
    endSeq?: number | null;
    onOutput?: (output: AgentOutput) => Promise<void>;
  },
): Promise<'success' | 'error'> {
  const {
    group,
    prompt,
    chatJid,
    runId,
    suppressToken,
    startSeq,
    endSeq,
    onOutput,
  } = args;
  const isMain = group.isMain === true;
  const isClaudeCodeAgent =
    (group.agentType || 'claude-code') === 'claude-code';
  const sessions = deps.getSessions();
  const sessionId = sessions[group.folder];
  const memoryBriefing = sessionId
    ? undefined
    : await buildRoomMemoryBriefing({
        groupFolder: group.folder,
        groupName: group.name,
      }).catch(() => undefined);

  const tasks = getAllTasks(group.agentType || 'claude-code');
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
  const currentLease = getEffectiveChannelLease(chatJid);
  const reviewerMode =
    currentLease.reviewer_service_id === SERVICE_SESSION_SCOPE;
  const effectivePrompt = buildSuppressTokenPrompt(prompt, suppressToken, {
    reviewerMode,
  });

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
      reason === 'org-access-denied'
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
    if (currentLease.reviewer_service_id === null) {
      return false;
    }

    activateCodexFailover(chatJid, `claude-${reason}`);
    createServiceHandoff({
      chat_jid: chatJid,
      group_folder: group.folder,
      source_service_id: SERVICE_SESSION_SCOPE,
      target_service_id: CODEX_REVIEW_SERVICE_ID,
      target_agent_type: 'codex',
      prompt,
      start_seq: startSeq ?? null,
      end_seq: endSeq ?? null,
      reason: `claude-${reason}`,
    });
    logger.warn(
      { chatJid, group: group.name, runId, reason },
      'Claude unavailable, handed off current turn to codex-review',
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
  };

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
            deps.persistSession(group.folder, output.newSessionId);
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

          if (
            evaluation.newTrigger &&
            typeof output.result === 'string' &&
            output.status === 'success'
          ) {
            logger.warn(
              {
                chatJid,
                group: group.name,
                runId,
                reason: evaluation.newTrigger.reason,
                resultPreview: output.result.slice(0, 120),
              },
              'Detected Claude rotation trigger in successful output',
            );
          } else if (
            evaluation.newTrigger &&
            typeof output.error === 'string'
          ) {
            logger.warn(
              {
                chatJid,
                group: group.name,
                runId,
                reason: evaluation.newTrigger.reason,
                errorPreview: output.error.slice(0, 120),
              },
              provider === 'claude'
                ? 'Detected Claude rotation trigger in streamed error output'
                : 'Detected Codex rotation trigger in streamed error output',
            );
          }

          if (evaluation.suppressedAuthError) {
            logger.warn(
              {
                chatJid,
                group: group.name,
                runId,
                resultPreview:
                  typeof output.result === 'string'
                    ? output.result.slice(0, 120)
                    : undefined,
              },
              'Suppressed Claude 401 auth error from chat output',
            );
            return;
          }

          if (evaluation.suppressedRetryableSessionFailure) {
            logger.warn(
              {
                chatJid,
                group: group.name,
                runId,
                resultPreview:
                  typeof output.result === 'string'
                    ? output.result.slice(0, 160)
                    : output.error?.slice(0, 160),
              },
              'Suppressed retryable Claude session failure from chat output',
            );
            return;
          }

          if (!evaluation.shouldForwardOutput) {
            return;
          }
          const suppressState =
            typeof output.result === 'string'
              ? classifySuppressTokenOutput(output.result, suppressToken)
              : 'none';
          if (
            typeof output.result === 'string' &&
            output.result.length > 0 &&
            suppressState === 'none'
          ) {
            streamedState = {
              ...evaluation.state,
              sawVisibleOutput: true,
            };
          }
          await onOutput(output);
        }
      : undefined;

    const agentType = group.agentType || 'claude-code';
    logger.info(
      {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        runId,
        provider: agentType,
      },
      `Using provider: ${agentType}`,
    );

    try {
      const output = await runAgentProcess(
        group,
        {
          ...agentInput,
          sessionId: provider === 'claude' ? sessionId : undefined,
        },
        (proc, processName, ipcDir) =>
          deps.queue.registerProcess(chatJid, proc, processName, ipcDir),
        wrappedOnOutput,
      );

      if (provider === 'claude' && output.newSessionId) {
        deps.persistSession(group.folder, output.newSessionId);
      }

      logger.info(
        {
          chatJid,
          group: group.name,
          groupFolder: group.folder,
          runId,
          provider,
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
      logger.info(
        { chatJid, group: group.name, runId, reason: trigger.reason },
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

        logger.error(
          {
            chatJid,
            group: group.name,
            groupFolder: group.folder,
            runId,
            provider: 'codex',
            err: retryAttempt.error,
          },
          'Rotated Codex account also threw',
        );
        return 'error';
      }

      const retryOutput = retryAttempt.output;
      if (!retryOutput) {
        logger.error(
          {
            chatJid,
            group: group.name,
            groupFolder: group.folder,
            runId,
            provider: 'codex',
          },
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

        logger.error(
          {
            group: group.name,
            chatJid,
            runId,
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
    deps.clearSession(group.folder);
    logger.warn(
      { group: group.name, chatJid, runId },
      'Cleared poisoned Claude session before visible output, retrying fresh session',
    );

    primaryAttempt = await runAttempt('claude');

    if (isRetryableClaudeSessionFailure(primaryAttempt)) {
      deps.clearSession(group.folder);
      logger.warn(
        { group: group.name, chatJid, runId },
        'Fresh Claude retry also hit a retryable session failure',
      );

      logger.error(
        { group: group.name, chatJid, runId },
        'Retryable Claude session failure persisted after fresh retry',
      );
      return 'error';
    }
  }

  if (primaryAttempt.error) {
    if (canRotateToken && provider === 'claude' && !primaryAttempt.sawOutput) {
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
        return result;
      }
    }

    if (!isClaudeCodeAgent) {
      const errMsg = getErrorMessage(primaryAttempt.error);
      const trigger = detectCodexRotationTrigger(errMsg);
      if (trigger.shouldRotate && getCodexAccountCount() > 1) {
        return retryCodexWithRotation({ reason: trigger.reason }, errMsg);
      }
    }

    logger.error(
      {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        runId,
        provider,
        err: primaryAttempt.error,
      },
      'Agent error',
    );
    return 'error';
  }

  const output = primaryAttempt.output;
  if (!output) {
    logger.error(
      {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        runId,
        provider,
      },
      'Agent produced no output object',
    );
    return 'error';
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
    deps.clearSession(group.folder);
    logger.warn(
      { group: group.name, chatJid, runId },
      'Cleared poisoned agent session after unrecoverable error',
    );
  }

  if (output.status === 'error') {
    if (canRotateToken && provider === 'claude' && !primaryAttempt.sawOutput) {
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
        return result;
      }
    }

    if (!isClaudeCodeAgent && getCodexAccountCount() > 1) {
      const trigger = detectCodexRotationTrigger(output.error);
      if (trigger.shouldRotate) {
        return retryCodexWithRotation(
          { reason: trigger.reason },
          output.error ?? undefined,
        );
      }
    }

    logger.error(
      {
        group: group.name,
        chatJid,
        runId,
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
    return retryCodexWithRotation(
      {
        reason: primaryAttempt.streamedTriggerReason
          .reason as CodexRotationReason,
      },
      output.error ?? output.result ?? undefined,
    );
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
    logger.error(
      {
        group: group.name,
        chatJid,
        runId,
        reason: primaryAttempt.streamedTriggerReason.reason,
      },
      'Agent trigger detected but could not be resolved',
    );
    return 'error';
  }

  // success-null-result with no visible output — agent returned nothing useful
  if (primaryAttempt.sawSuccessNullResultWithoutOutput) {
    logger.error(
      { group: group.name, chatJid, runId },
      'Agent returned success with null result and no visible output',
    );
    return 'error';
  }

  return 'success';
}
