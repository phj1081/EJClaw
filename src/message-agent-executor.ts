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
            isClaudeUsageExhaustedMessage(output.result)
          ) {
            if (!streamedTriggerReason) {
              logger.warn(
                {
                  chatJid,
                  group: group.name,
                  runId,
                  resultPreview: output.result.slice(0, 120),
                },
                'Detected Claude usage exhaustion banner in successful output',
              );
            }
            streamedTriggerReason = {
              reason: 'usage-exhausted',
            };
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
            const trigger = detectFallbackTrigger(output.error);
            if (trigger.shouldFallback) {
              streamedTriggerReason = {
                reason: trigger.reason,
                retryAfterMs: trigger.retryAfterMs,
              };
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
    reason === '429' || reason === 'usage-exhausted';

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

    // Codex rate-limit rotation (non-Claude agents)
    if (!isClaudeCodeAgent && getCodexAccountCount() > 1) {
      const trigger = detectFallbackTrigger(output.error);
      if (
        trigger.shouldFallback &&
        rotateCodexToken(output.error ?? undefined)
      ) {
        logger.info(
          { chatJid, group: group.name, runId, reason: trigger.reason },
          'Codex rate-limited, retrying with rotated account',
        );
        const retryAttempt = await runAttempt('codex');
        if (!retryAttempt.error) {
          markCodexTokenHealthy();
          return 'success';
        }
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

  // Codex may report success but have streamed a rate-limit error.
  // Rotate token and retry immediately with the new account.
  if (
    !isClaudeCodeAgent &&
    primaryAttempt.streamedTriggerReason &&
    getCodexAccountCount() > 1 &&
    rotateCodexToken(output.error ?? undefined)
  ) {
    logger.info(
      {
        chatJid,
        group: group.name,
        runId,
        reason: primaryAttempt.streamedTriggerReason.reason,
      },
      'Codex rate-limited (streamed), retrying with rotated account',
    );
    const retryAttempt = await runAttempt('codex');
    if (!retryAttempt.error) {
      markCodexTokenHealthy();
      return 'success';
    }
  }

  return 'success';
}
