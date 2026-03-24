import path from 'path';

import {
  AgentOutput,
  runAgentProcess,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './agent-runner.js';
import { listAvailableGroups } from './available-groups.js';
import { DATA_DIR } from './config.js';
import { getAllTasks } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { buildRoomMemoryBriefing } from './memento-client.js';
import {
  detectFallbackTrigger,
  getActiveProvider,
  getFallbackEnvOverrides,
  getFallbackProviderName,
  hasGroupProviderOverride,
  isFallbackEnabled,
  isUsageExhausted,
  markPrimaryCooldown,
} from './provider-fallback.js';
import { shouldResetSessionOnAgentFailure } from './session-recovery.js';
import {
  detectCodexRotationTrigger,
  rotateCodexToken,
  getCodexAccountCount,
  markCodexTokenHealthy,
} from './codex-token-rotation.js';
import {
  rotateToken,
  getTokenCount,
  markTokenHealthy,
} from './token-rotation.js';
import type { RegisteredGroup } from './types.js';

export interface MessageAgentExecutorDeps {
  assistantName: string;
  queue: Pick<GroupQueue, 'registerProcess'>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  persistSession: (groupFolder: string, sessionId: string) => void;
  clearSession: (groupFolder: string) => void;
}

function isClaudeAuthError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('failed to authenticate') &&
    (lower.includes('401') || lower.includes('authentication_error'))
  );
}

function isClaudeUsageExhaustedMessage(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^error:\s*/i, '');
  const looksLikeBanner =
    normalized.startsWith("you're out of extra usage") ||
    normalized.startsWith('you are out of extra usage') ||
    normalized.startsWith("you've hit your limit") ||
    normalized.startsWith('you have hit your limit');
  const hasResetHint =
    normalized.includes('resets ') ||
    normalized.includes('reset at ') ||
    normalized.includes('try again');
  return looksLikeBanner && hasResetHint && normalized.length <= 160;
}

function isClaudeAuthExpiredMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const looksLikeAuthFailure = normalized.startsWith('failed to authenticate');
  const hasExpiredTokenMarker =
    normalized.includes('oauth token has expired') ||
    normalized.includes('authentication_error') ||
    normalized.includes('obtain a new token') ||
    normalized.includes('refresh your existing token') ||
    normalized.includes('invalid authentication credentials');
  const hasUnauthorizedMarker =
    normalized.includes('401') || normalized.includes('authentication error');
  const hasTerminatedMarker = normalized.includes('terminated');

  return (
    looksLikeAuthFailure &&
    hasUnauthorizedMarker &&
    (hasExpiredTokenMarker || hasTerminatedMarker)
  );
}

export async function runAgentForGroup(
  deps: MessageAgentExecutorDeps,
  args: {
    group: RegisteredGroup;
    prompt: string;
    chatJid: string;
    runId: string;
    onOutput?: (output: AgentOutput) => Promise<void>;
  },
): Promise<'success' | 'error'> {
  const { group, prompt, chatJid, runId, onOutput } = args;
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

  const settingsPath = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
    'settings.json',
  );
  const groupHasOverride = hasGroupProviderOverride(settingsPath);
  const canFallback =
    isClaudeCodeAgent && isFallbackEnabled() && !groupHasOverride;

  const agentInput = {
    prompt,
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
    sawSuccessNullResultWithoutOutput: boolean;
    streamedTriggerReason?: {
      reason: string;
      retryAfterMs?: number;
    };
  }> => {
    const persistSessionIds = provider === 'claude';
    let sawOutput = false;
    let sawSuccessNullResultWithoutOutput = false;
    let streamedTriggerReason:
      | {
          reason: string;
          retryAfterMs?: number;
        }
      | undefined;

    const wrappedOnOutput = onOutput
      ? async (output: AgentOutput) => {
          if (persistSessionIds && output.newSessionId) {
            deps.persistSession(group.folder, output.newSessionId);
          }
          if (
            persistSessionIds &&
            isClaudeCodeAgent &&
            shouldResetSessionOnAgentFailure(output)
          ) {
            resetSessionRequested = true;
          }
          if (
            canFallback &&
            provider === 'claude' &&
            output.status === 'success' &&
            !sawOutput &&
            typeof output.result === 'string' &&
            (isClaudeUsageExhaustedMessage(output.result) ||
              isClaudeAuthExpiredMessage(output.result))
          ) {
            if (!streamedTriggerReason) {
              const reason = isClaudeUsageExhaustedMessage(output.result)
                ? 'usage-exhausted'
                : 'auth-expired';
              logger.warn(
                {
                  chatJid,
                  group: group.name,
                  runId,
                  reason,
                  resultPreview: output.result.slice(0, 120),
                },
                'Detected Claude fallback trigger in successful output',
              );
            }
            streamedTriggerReason = {
              reason: isClaudeUsageExhaustedMessage(output.result)
                ? 'usage-exhausted'
                : 'auth-expired',
            };
            return;
          }
          // 401 auth errors — suppress from chat, log only
          if (
            provider === 'claude' &&
            output.status === 'success' &&
            !sawOutput &&
            typeof output.result === 'string' &&
            isClaudeAuthError(output.result)
          ) {
            logger.warn(
              {
                chatJid,
                group: group.name,
                runId,
                resultPreview: output.result.slice(0, 120),
              },
              'Suppressed Claude 401 auth error from chat output',
            );
            return;
          }
          if (output.result !== null && output.result !== undefined) {
            sawOutput = true;
          } else if (
            provider === 'claude' &&
            output.status === 'success' &&
            !sawOutput
          ) {
            sawSuccessNullResultWithoutOutput = true;
          }
          if (
            output.status === 'error' &&
            !sawOutput &&
            !streamedTriggerReason
          ) {
            if (provider === 'claude') {
              const trigger = detectFallbackTrigger(output.error);
              if (trigger.shouldFallback) {
                streamedTriggerReason = {
                  reason: trigger.reason,
                  retryAfterMs: trigger.retryAfterMs,
                };
                if (canFallback) {
                  return;
                }
              }
            } else {
              const trigger = detectCodexRotationTrigger(output.error);
              if (trigger.shouldRotate) {
                streamedTriggerReason = {
                  reason: trigger.reason,
                };
                if (getCodexAccountCount() > 1) {
                  return;
                }
              }
            }
          }
          await onOutput(output);
        }
      : undefined;

    if (provider !== 'claude') {
      logger.info(
        {
          chatJid,
          group: group.name,
          groupFolder: group.folder,
          runId,
          provider,
        },
        `Claude provider in cooldown, routing request to ${provider}`,
      );
    }

    const agentType = group.agentType || 'claude-code';
    const providerLabel = canFallback ? provider : agentType;
    logger.info(
      {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        runId,
        provider: providerLabel,
        canFallback,
        groupHasOverride,
      },
      `Using provider: ${providerLabel}`,
    );

    try {
      const output = await runAgentProcess(
        group,
        {
          ...agentInput,
          sessionId: persistSessionIds ? sessionId : undefined,
        },
        (proc, processName, ipcDir) =>
          deps.queue.registerProcess(chatJid, proc, processName, ipcDir),
        wrappedOnOutput,
        provider === 'claude' ? undefined : getFallbackEnvOverrides(),
      );

      if (persistSessionIds && output.newSessionId) {
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
          sawOutput,
        },
        `Provider response completed (provider: ${provider})`,
      );

      return {
        output,
        sawOutput,
        sawSuccessNullResultWithoutOutput,
        streamedTriggerReason,
      };
    } catch (error) {
      return {
        error,
        sawOutput,
        sawSuccessNullResultWithoutOutput,
        streamedTriggerReason,
      };
    }
  };

  const runFallbackAttempt = async (
    reason: string,
    retryAfterMs?: number,
  ): Promise<'success' | 'error'> => {
    const fallbackName = getFallbackProviderName();
    markPrimaryCooldown(reason, retryAfterMs);

    logger.info(
      {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        runId,
        reason,
        retryAfterMs,
        fallbackProvider: fallbackName,
      },
      `Falling back to provider: ${fallbackName} (reason: ${reason})`,
    );

    const fallbackAttempt = await runAttempt(fallbackName);
    if (fallbackAttempt.error) {
      logger.error(
        {
          chatJid,
          group: group.name,
          groupFolder: group.folder,
          runId,
          provider: fallbackName,
          err: fallbackAttempt.error,
        },
        'Fallback provider also threw',
      );
      return 'error';
    }

    if (fallbackAttempt.output?.status === 'error') {
      logger.error(
        {
          chatJid,
          group: group.name,
          groupFolder: group.folder,
          runId,
          provider: fallbackName,
          error: fallbackAttempt.output.error,
        },
        `Fallback provider (${fallbackName}) also failed`,
      );
      return 'error';
    }

    return 'success';
  };

  const shouldRotateClaudeToken = (reason: string): boolean =>
    reason === '429' ||
    reason === 'usage-exhausted' ||
    reason === 'auth-expired';

  const retryCodexWithRotation = async (
    initialTrigger: { reason: string },
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
        const errMsg =
          retryAttempt.error instanceof Error
            ? retryAttempt.error.message
            : String(retryAttempt.error);
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
        trigger = { reason: retryAttempt.streamedTriggerReason.reason };
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
              reason: retryAttempt.streamedTriggerReason.reason,
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
      reason: string;
      retryAfterMs?: number;
    },
    rotationMessage?: string,
  ): Promise<'success' | 'error'> => {
    let trigger = initialTrigger;
    let lastRotationMessage = rotationMessage;

    while (
      shouldRotateClaudeToken(trigger.reason) &&
      getTokenCount() > 1 &&
      rotateToken(lastRotationMessage, { ignoreRateLimits: true })
    ) {
      logger.info(
        { chatJid, group: group.name, runId, reason: trigger.reason },
        'Claude rate-limited, retrying with rotated account',
      );

      const retryAttempt = await runAttempt('claude');

      if (retryAttempt.error) {
        if (!retryAttempt.sawOutput) {
          const errMsg =
            retryAttempt.error instanceof Error
              ? retryAttempt.error.message
              : String(retryAttempt.error);
          const retryTrigger = retryAttempt.streamedTriggerReason
            ? {
                shouldFallback: true,
                reason: retryAttempt.streamedTriggerReason.reason,
                retryAfterMs: retryAttempt.streamedTriggerReason.retryAfterMs,
              }
            : detectFallbackTrigger(errMsg);
          if (retryTrigger.shouldFallback) {
            trigger = {
              reason: retryTrigger.reason,
              retryAfterMs: retryTrigger.retryAfterMs,
            };
            lastRotationMessage = errMsg;
            continue;
          }
        }

        logger.error(
          {
            chatJid,
            group: group.name,
            groupFolder: group.folder,
            runId,
            provider: 'claude',
            err: retryAttempt.error,
          },
          'Rotated Claude account also threw',
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
            provider: 'claude',
          },
          'Rotated Claude account produced no output object',
        );
        return 'error';
      }

      if (
        !retryAttempt.sawOutput &&
        retryAttempt.streamedTriggerReason &&
        retryOutput.status !== 'error'
      ) {
        trigger = {
          reason: retryAttempt.streamedTriggerReason.reason,
          retryAfterMs: retryAttempt.streamedTriggerReason.retryAfterMs,
        };
        lastRotationMessage =
          typeof retryOutput.result === 'string'
            ? retryOutput.result
            : undefined;
        continue;
      }

      if (
        !retryAttempt.sawOutput &&
        retryAttempt.sawSuccessNullResultWithoutOutput
      ) {
        return runFallbackAttempt('success-null-result');
      }

      if (retryOutput.status === 'error') {
        if (!retryAttempt.sawOutput) {
          const retryTrigger = retryAttempt.streamedTriggerReason
            ? {
                shouldFallback: true,
                reason: retryAttempt.streamedTriggerReason.reason,
                retryAfterMs: retryAttempt.streamedTriggerReason.retryAfterMs,
              }
            : detectFallbackTrigger(retryOutput.error);
          if (retryTrigger.shouldFallback) {
            trigger = {
              reason: retryTrigger.reason,
              retryAfterMs: retryTrigger.retryAfterMs,
            };
            lastRotationMessage = retryOutput.error ?? undefined;
            continue;
          }
        }

        logger.error(
          {
            group: group.name,
            chatJid,
            runId,
            provider: 'claude',
            error: retryOutput.error,
          },
          'Rotated Claude account failed',
        );
        return 'error';
      }

      markTokenHealthy();
      return 'success';
    }

    // Usage exhausted: don't fall back to Kimi — log only, no response
    if (trigger.reason === 'usage-exhausted') {
      markPrimaryCooldown(trigger.reason, trigger.retryAfterMs);
      logger.info(
        { chatJid, group: group.name, runId },
        'All Claude tokens usage-exhausted, silently skipping (no Kimi fallback)',
      );
      return 'error';
    }

    return runFallbackAttempt(trigger.reason, trigger.retryAfterMs);
  };

  const provider = canFallback ? await getActiveProvider() : 'claude';

  // Already in usage-exhausted cooldown — log only, no response
  if (provider !== 'claude' && isUsageExhausted()) {
    logger.info(
      { chatJid, group: group.name, runId, provider },
      'Claude usage exhausted (cooldown active), silently skipping',
    );
    return 'error';
  }

  const primaryAttempt = await runAttempt(provider);

  if (primaryAttempt.error) {
    if (canFallback && provider === 'claude' && !primaryAttempt.sawOutput) {
      const errMsg =
        primaryAttempt.error instanceof Error
          ? primaryAttempt.error.message
          : String(primaryAttempt.error);
      const trigger = primaryAttempt.streamedTriggerReason
        ? {
            shouldFallback: true,
            reason: primaryAttempt.streamedTriggerReason.reason,
            retryAfterMs: primaryAttempt.streamedTriggerReason.retryAfterMs,
          }
        : detectFallbackTrigger(errMsg);
      if (trigger.shouldFallback) {
        return retryClaudeWithRotation(
          {
            reason: trigger.reason,
            retryAfterMs: trigger.retryAfterMs,
          },
          errMsg,
        );
      }
    }

    if (!isClaudeCodeAgent) {
      const errMsg =
        primaryAttempt.error instanceof Error
          ? primaryAttempt.error.message
          : String(primaryAttempt.error);
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
    canFallback &&
    provider === 'claude' &&
    !primaryAttempt.sawOutput &&
    primaryAttempt.streamedTriggerReason &&
    output.status !== 'error'
  ) {
    return retryClaudeWithRotation({
      reason: primaryAttempt.streamedTriggerReason.reason,
      retryAfterMs: primaryAttempt.streamedTriggerReason.retryAfterMs,
    });
  }

  if (
    canFallback &&
    provider === 'claude' &&
    !primaryAttempt.sawOutput &&
    primaryAttempt.sawSuccessNullResultWithoutOutput
  ) {
    return runFallbackAttempt('success-null-result');
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
    if (canFallback && provider === 'claude' && !primaryAttempt.sawOutput) {
      const trigger = primaryAttempt.streamedTriggerReason
        ? {
            shouldFallback: true,
            reason: primaryAttempt.streamedTriggerReason.reason,
            retryAfterMs: primaryAttempt.streamedTriggerReason.retryAfterMs,
          }
        : detectFallbackTrigger(output.error);
      if (trigger.shouldFallback) {
        return retryClaudeWithRotation(
          {
            reason: trigger.reason,
            retryAfterMs: trigger.retryAfterMs,
          },
          output.error ?? undefined,
        );
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
      { reason: primaryAttempt.streamedTriggerReason.reason },
      output.error ?? output.result ?? undefined,
    );
  }

  return 'success';
}
