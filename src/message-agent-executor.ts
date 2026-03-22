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
  markPrimaryCooldown,
} from './provider-fallback.js';
import { shouldResetSessionOnAgentFailure } from './session-recovery.js';
import type { RegisteredGroup } from './types.js';

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
            provider === 'claude' &&
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

    logger.info(
      {
        chatJid,
        group: group.name,
        groupFolder: group.folder,
        runId,
        provider,
        canFallback,
        groupHasOverride,
      },
      `Using provider: ${provider}`,
    );

    try {
      const output = await runAgentProcess(
        group,
        {
          ...agentInput,
          sessionId: persistSessionIds ? sessionId : undefined,
        },
        (proc, processName) =>
          deps.queue.registerProcess(chatJid, proc, processName, group.folder),
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

  const provider = canFallback ? getActiveProvider() : 'claude';
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
        return runFallbackAttempt(trigger.reason, trigger.retryAfterMs);
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
        return runFallbackAttempt(trigger.reason, trigger.retryAfterMs);
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

  return 'success';
}
