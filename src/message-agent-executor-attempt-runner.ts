import type { Logger } from 'pino';

import {
  createEvaluatedOutputHandler,
  type EvaluatedAgentOutput,
} from './agent-attempt.js';
import type { AttemptStreamedTrigger } from './agent-attempt-retry.js';
import { runAgentProcess, type AgentOutput } from './agent-runner.js';
import { markCompactRefreshNeeded } from './compact-refresh.js';
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

function maybeMarkCompactRefreshForOutput(args: {
  output: AgentOutput;
  activeRole: string;
  sessionFolder: string;
}): void {
  if (
    (args.activeRole !== 'owner' && args.activeRole !== 'reviewer') ||
    args.output.compaction?.completed !== true ||
    !args.output.newSessionId
  ) {
    return;
  }
  markCompactRefreshNeeded({
    sessionFolder: args.sessionFolder,
    sessionId: args.output.newSessionId,
    trigger: args.output.compaction.trigger ?? null,
  });
}

function createProviderLog(
  log: Logger,
  provider: 'claude' | 'codex',
  agentType: AgentType,
): Logger {
  const providerLog = log.child({ provider, agentType });
  providerLog.info('Using provider');
  return providerLog;
}

interface RunMessageAgentAttemptArgs {
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
}

type StreamedOutputHandler = ReturnType<typeof createEvaluatedOutputHandler>;

class MessageAgentAttemptRunner {
  private resetSessionRequested = false;
  private readonly attemptSessionId: string | undefined;
  private readonly streamedOutputHandler: StreamedOutputHandler;

  constructor(private readonly args: RunMessageAgentAttemptArgs) {
    this.attemptSessionId = args.currentSessionId;
    this.streamedOutputHandler = createEvaluatedOutputHandler({
      agentType: args.isClaudeCodeAgent ? 'claude-code' : 'codex',
      provider: args.provider,
      evaluationOptions: {
        suppressClaudeAuthErrorOutput: args.provider === 'claude',
        trackSuccessNullResult: true,
        shortCircuitTriggeredErrors:
          args.provider === 'claude'
            ? args.canRetryClaudeCredentials
            : getCodexAccountCount() > 1,
      },
      onEvaluatedOutput: (event) => this.handleEvaluatedOutput(event),
    });
  }

  async run(): Promise<MessageAgentAttempt> {
    const providerLog = createProviderLog(
      this.args.log,
      this.args.provider,
      this.args.effectiveAgentType,
    );

    try {
      const output = await this.runAgentProcessWithStreaming();
      this.persistReturnedSession(output);
      maybeMarkCompactRefreshForOutput({
        output,
        activeRole: this.args.activeRole,
        sessionFolder: this.args.sessionFolder,
      });
      providerLog.info(
        {
          status: output.status,
          sawOutput: this.streamedOutputHandler.getState().sawOutput,
        },
        `Provider response completed (provider: ${this.args.provider})`,
      );
      return this.buildAttempt({ output });
    } catch (error) {
      return this.buildAttempt({ error });
    }
  }

  private async runAgentProcessWithStreaming(): Promise<AgentOutput> {
    return runAgentProcess(
      this.args.effectiveGroup,
      {
        ...this.args.agentInput,
        sessionId: this.attemptSessionId,
      },
      this.args.registerProcess,
      (output) => this.streamedOutputHandler.handleOutput(output),
      this.args.pairedExecutionContext?.envOverrides,
    );
  }

  private async handleEvaluatedOutput(
    event: EvaluatedAgentOutput,
  ): Promise<void> {
    maybeMarkCompactRefreshForOutput({
      output: event.output,
      activeRole: this.args.activeRole,
      sessionFolder: this.args.sessionFolder,
    });
    this.logNonFinalOutput(event);
    this.trackSessionResetRequest(event.output);
    this.persistStreamedSession(event.output);
    this.updatePairedSummary(event);
    this.logEvaluationTrigger(event);
    if (this.suppressedOutputWasHandled(event)) {
      return;
    }
    if (!event.evaluation.shouldForwardOutput) {
      return;
    }
    await this.forwardOutputIfAccepted(event);
  }

  private logNonFinalOutput(event: EvaluatedAgentOutput): void {
    const outputPhase = event.output.phase ?? 'final';
    if (outputPhase === 'final') {
      return;
    }
    this.args.log.info(
      {
        provider: this.args.provider,
        outputPhase,
        outputStatus: event.output.status,
        visibility: event.structuredOutput?.visibility ?? null,
        preview:
          event.outputText && event.outputText.length > 0
            ? event.outputText.slice(0, 160)
            : null,
        errorPreview:
          typeof event.output.error === 'string' &&
          event.output.error.length > 0
            ? event.output.error.slice(0, 160)
            : null,
        activeRole: this.args.activeRole,
        effectiveServiceId: this.args.effectiveServiceId,
        effectiveAgentType: this.args.effectiveAgentType,
        sessionFolder: this.args.sessionFolder,
        resumedSession: this.attemptSessionId ?? null,
        streamedSessionId: event.output.newSessionId ?? null,
        roomRoleServiceId: this.args.roomRoleContext?.serviceId ?? null,
        roomRole: this.args.roomRoleContext?.role ?? null,
        pairedTaskId: this.args.pairedExecutionContext?.task.id ?? null,
        workspaceDir:
          this.args.pairedExecutionContext?.workspace?.workspace_dir ??
          this.args.fallbackWorkspaceDir ??
          null,
      },
      'Observed streamed agent activity',
    );
  }

  private trackSessionResetRequest(output: AgentOutput): void {
    if (
      this.args.isClaudeCodeAgent &&
      this.args.provider === 'claude' &&
      shouldResetSessionOnAgentFailure(output)
    ) {
      this.resetSessionRequested = true;
    }
    if (
      !this.args.isClaudeCodeAgent &&
      this.args.provider === 'codex' &&
      shouldResetCodexSessionOnAgentFailure(output)
    ) {
      this.resetSessionRequested = true;
    }
  }

  private persistStreamedSession(output: AgentOutput): void {
    if (
      output.newSessionId &&
      !this.resetSessionRequested &&
      this.args.shouldPersistSession
    ) {
      this.args.onPersistSession(output.newSessionId);
    }
  }

  private persistReturnedSession(output: AgentOutput): void {
    if (output.newSessionId && this.args.shouldPersistSession) {
      this.args.onPersistSession(output.newSessionId);
    }
  }

  private updatePairedSummary(event: EvaluatedAgentOutput): void {
    this.args.pairedExecutionLifecycle.updateSummary({
      outputText: event.outputText,
      errorText:
        typeof event.output.error === 'string' ? event.output.error : null,
    });
  }

  private logEvaluationTrigger(event: EvaluatedAgentOutput): void {
    if (
      event.evaluation.newTrigger &&
      event.outputText &&
      event.output.status === 'success'
    ) {
      this.args.log.warn(
        {
          reason: event.evaluation.newTrigger.reason,
          resultPreview: event.outputText.slice(0, 120),
        },
        'Detected Claude rotation trigger in successful output',
      );
      return;
    }
    if (event.evaluation.newTrigger && typeof event.output.error === 'string') {
      this.args.log.warn(
        {
          reason: event.evaluation.newTrigger.reason,
          errorPreview: event.output.error.slice(0, 120),
        },
        this.args.provider === 'claude'
          ? 'Detected Claude rotation trigger in streamed error output'
          : 'Detected Codex rotation trigger in streamed error output',
      );
    }
  }

  private suppressedOutputWasHandled(event: EvaluatedAgentOutput): boolean {
    if (event.evaluation.suppressedAuthError) {
      this.args.log.warn(
        {
          resultPreview: event.outputText
            ? event.outputText.slice(0, 120)
            : undefined,
        },
        'Suppressed Claude 401 auth error from chat output',
      );
      return true;
    }
    if (event.evaluation.suppressedRetryableSessionFailure) {
      this.args.log.warn(
        {
          resultPreview: event.outputText
            ? event.outputText.slice(0, 160)
            : event.output.error?.slice(0, 160),
        },
        this.args.provider === 'claude'
          ? 'Suppressed retryable Claude session failure from chat output'
          : 'Suppressed retryable Codex session failure from chat output',
      );
      return true;
    }
    return false;
  }

  private async forwardOutputIfAccepted(
    event: EvaluatedAgentOutput,
  ): Promise<void> {
    if (event.outputText && event.outputText.length > 0) {
      this.streamedOutputHandler.markVisibleOutput();
    }
    if (!this.finalOutputWasAccepted(event)) {
      return;
    }
    await this.args.onOutput?.(event.output);
  }

  private finalOutputWasAccepted(event: EvaluatedAgentOutput): boolean {
    const outputPhase = event.output.phase ?? 'final';
    if (
      outputPhase !== 'final' ||
      event.output.status !== 'success' ||
      !event.outputText ||
      event.outputText.length === 0
    ) {
      return true;
    }
    try {
      return this.args.pairedExecutionLifecycle.recordFinalOutputBeforeDelivery(
        event.outputText,
      );
    } catch (err) {
      this.args.log.warn(
        {
          pairedTaskId: this.args.pairedExecutionContext?.task.id ?? null,
          err,
        },
        'Failed to persist paired turn output and status before delivery',
      );
      return true;
    }
  }

  private buildAttempt(args: {
    output?: AgentOutput;
    error?: unknown;
  }): MessageAgentAttempt {
    const streamedState = this.streamedOutputHandler.getState();
    return {
      ...args,
      sawOutput: streamedState.sawOutput,
      sawVisibleOutput: streamedState.sawVisibleOutput,
      sawSuccessNullResultWithoutOutput:
        streamedState.sawSuccessNullResultWithoutOutput,
      retryableSessionFailureDetected:
        streamedState.retryableSessionFailureDetected === true,
      resetSessionRequested: this.resetSessionRequested,
      streamedTriggerReason: streamedState.streamedTriggerReason,
    };
  }
}

export async function runMessageAgentAttempt(
  args: RunMessageAgentAttemptArgs,
): Promise<MessageAgentAttempt> {
  return new MessageAgentAttemptRunner(args).run();
}
