import type { Logger } from 'pino';

import { createEvaluatedOutputHandler } from './agent-attempt.js';
import type { AttemptStreamedTrigger } from './agent-attempt-retry.js';
import { runAgentProcess, type AgentOutput } from './agent-runner.js';
import { getCodexAccountCount } from './codex-token-rotation.js';
import type { PreparedPairedExecutionContext } from './paired-execution-context.js';
import {
  shouldResetCodexSessionOnAgentFailure,
  shouldResetSessionOnAgentFailure,
} from './session-recovery.js';
import type { AgentType, RegisteredGroup, RoomRoleContext } from './types.js';

export interface MessageAgentAttempt {
  output?: AgentOutput;
  error?: unknown;
  sawOutput: boolean;
  sawVisibleOutput: boolean;
  sawSuccessNullResultWithoutOutput: boolean;
  retryableSessionFailureDetected: boolean;
  resetSessionRequested: boolean;
  streamedTriggerReason?: AttemptStreamedTrigger;
}

interface AgentInput {
  prompt: string;
  sessionId?: string;
  memoryBriefing?: string;
  groupFolder: string;
  chatJid: string;
  runId: string;
  isMain: boolean;
  assistantName: string;
  roomRoleContext?: RoomRoleContext;
}

export async function runMessageAgentAttempt(args: {
  provider: 'claude' | 'codex';
  currentSessionId: string | undefined;
  isClaudeCodeAgent: boolean;
  canRetryClaudeCredentials: boolean;
  shouldPersistSession: boolean;
  effectiveGroup: RegisteredGroup;
  agentInput: AgentInput;
  activeRole: string;
  effectiveServiceId: string;
  effectiveAgentType: AgentType;
  sessionFolder: string;
  roomRoleContext?: RoomRoleContext;
  pairedExecutionContext?: PreparedPairedExecutionContext;
  fallbackWorkspaceDir?: string | null;
  onPersistSession: (sessionId: string) => void;
  registerProcess: (
    proc: Parameters<typeof runAgentProcess>[2] extends (
      proc: infer TProc,
      processName: infer TProcessName,
      ipcDir: infer TIpcDir,
    ) => unknown
      ? TProc
      : never,
    processName: string,
    ipcDir?: string,
  ) => void;
  onOutput?: (output: AgentOutput) => Promise<void>;
  pairedExecutionLifecycle: {
    updateSummary(args: {
      outputText?: string | null;
      errorText?: string | null;
    }): void;
    recordFinalOutputBeforeDelivery(outputText: string): boolean;
  };
  log: Logger;
}): Promise<MessageAgentAttempt> {
  const {
    provider,
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
    fallbackWorkspaceDir,
    onPersistSession,
    registerProcess,
    onOutput,
    pairedExecutionLifecycle,
    log,
  } = args;
  const attemptSessionId = currentSessionId;
  let resetSessionRequested = false;
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
              fallbackWorkspaceDir ??
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
        !isClaudeCodeAgent &&
        provider === 'codex' &&
        shouldResetCodexSessionOnAgentFailure(output)
      ) {
        resetSessionRequested = true;
      }
      if (
        output.newSessionId &&
        !resetSessionRequested &&
        shouldPersistSession
      ) {
        onPersistSession(output.newSessionId);
      }

      pairedExecutionLifecycle.updateSummary({
        outputText,
        errorText: typeof output.error === 'string' ? output.error : null,
      });
      if (evaluation.newTrigger && outputText && output.status === 'success') {
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
          provider === 'claude'
            ? 'Suppressed retryable Claude session failure from chat output'
            : 'Suppressed retryable Codex session failure from chat output',
        );
        return;
      }

      if (!evaluation.shouldForwardOutput) {
        return;
      }
      if (outputText && outputText.length > 0) {
        streamedOutputHandler.markVisibleOutput();
      }
      if (
        outputPhase === 'final' &&
        output.status === 'success' &&
        outputText &&
        outputText.length > 0
      ) {
        let finalOutputAccepted = true;
        try {
          finalOutputAccepted =
            pairedExecutionLifecycle.recordFinalOutputBeforeDelivery(
              outputText,
            );
        } catch (err) {
          log.warn(
            { pairedTaskId: pairedExecutionContext?.task.id ?? null, err },
            'Failed to persist paired turn output and status before delivery',
          );
        }
        if (!finalOutputAccepted) {
          return;
        }
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
      registerProcess,
      wrappedOnOutput,
      pairedExecutionContext?.envOverrides,
    );

    if (output.newSessionId && shouldPersistSession) {
      onPersistSession(output.newSessionId);
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
      resetSessionRequested,
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
      resetSessionRequested,
      streamedTriggerReason: streamedState.streamedTriggerReason,
    };
  }
}
