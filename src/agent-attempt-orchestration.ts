import type { AgentOutput } from './agent-runner.js';
import {
  resolveAttemptRetryAction,
  type AttemptRetryAction,
  type AttemptRetryState,
} from './agent-attempt-retry.js';
import type {
  AgentTriggerReason,
  CodexRotationReason,
} from './agent-error-detection.js';
import {
  runClaudeRotationLoop,
  runCodexRotationLoop,
} from './provider-retry.js';

type RotationLogContext = Record<string, unknown>;

type ClaudeRetryAttemptState = Pick<
  AttemptRetryState,
  'sawOutput' | 'streamedTriggerReason'
> & {
  output?: Pick<AgentOutput, 'status' | 'result' | 'output' | 'error'>;
  error?: unknown;
  sawSuccessNullResultWithoutOutput?: boolean;
};

type CodexRetryAttemptState = Pick<
  AttemptRetryState,
  'sawOutput' | 'streamedTriggerReason'
> & {
  output?: Pick<AgentOutput, 'status' | 'result' | 'output' | 'error'>;
  error?: unknown;
};

export type ExecutedAttemptRetryAction =
  | { kind: 'none' }
  | {
      kind: 'claude';
      trigger: { reason: AgentTriggerReason; retryAfterMs?: number };
      rotationMessage?: string;
      result: 'success' | 'error';
    }
  | {
      kind: 'codex';
      trigger: { reason: CodexRotationReason };
      rotationMessage?: string;
      result: 'success' | 'error';
    };

export async function runClaudeAttemptWithRotation<
  TAttempt extends ClaudeRetryAttemptState,
>(args: {
  initialTrigger: {
    reason: AgentTriggerReason;
    retryAfterMs?: number;
  };
  runAttempt: () => Promise<TAttempt>;
  logContext: RotationLogContext;
  rotationMessage?: string;
  afterAttempt?: (attempt: TAttempt) => Promise<void> | void;
  onSuccess?: (outcome: { sawOutput: boolean }) => Promise<void> | void;
}): Promise<'success' | 'error'> {
  const outcome = await runClaudeRotationLoop(
    args.initialTrigger,
    async () => {
      const attempt = await args.runAttempt();
      await args.afterAttempt?.(attempt);
      return {
        output: attempt.output,
        thrownError: attempt.error,
        sawOutput: attempt.sawOutput,
        sawSuccessNullResult: attempt.sawSuccessNullResultWithoutOutput,
        streamedTriggerReason: attempt.streamedTriggerReason,
      };
    },
    args.logContext,
    args.rotationMessage,
  );

  if (outcome.type === 'success') {
    await args.onSuccess?.({ sawOutput: outcome.sawOutput });
    return 'success';
  }

  return 'error';
}

export async function runCodexAttemptWithRotation<
  TAttempt extends CodexRetryAttemptState,
>(args: {
  initialTrigger: { reason: CodexRotationReason };
  runAttempt: () => Promise<TAttempt>;
  logContext: RotationLogContext;
  rotationMessage?: string;
  afterAttempt?: (attempt: TAttempt) => Promise<void> | void;
}): Promise<'success' | 'error'> {
  const outcome = await runCodexRotationLoop(
    args.initialTrigger,
    async () => {
      const attempt = await args.runAttempt();
      await args.afterAttempt?.(attempt);
      return {
        output: attempt.output,
        thrownError: attempt.error,
        sawOutput: attempt.sawOutput,
        streamedTriggerReason: attempt.streamedTriggerReason,
      };
    },
    args.logContext,
    args.rotationMessage,
  );

  return outcome.type === 'success' ? 'success' : 'error';
}

export async function executeAttemptRetryAction(args: {
  provider: 'claude' | 'codex';
  canRetryClaudeCredentials: boolean;
  canRetryCodex: boolean;
  attempt: Pick<AttemptRetryState, 'sawOutput' | 'streamedTriggerReason'>;
  rotationMessage?: string | null;
  runClaude: (
    trigger: { reason: AgentTriggerReason; retryAfterMs?: number },
    rotationMessage?: string,
  ) => Promise<'success' | 'error'>;
  runCodex: (
    trigger: { reason: CodexRotationReason },
    rotationMessage?: string,
  ) => Promise<'success' | 'error'>;
}): Promise<ExecutedAttemptRetryAction> {
  const retryAction = resolveAttemptRetryAction({
    provider: args.provider,
    canRetryClaudeCredentials: args.canRetryClaudeCredentials,
    canRetryCodex: args.canRetryCodex,
    attempt: args.attempt,
    rotationMessage: args.rotationMessage,
  });

  return executeResolvedAttemptRetryAction({
    retryAction,
    runClaude: args.runClaude,
    runCodex: args.runCodex,
  });
}

async function executeResolvedAttemptRetryAction(args: {
  retryAction: AttemptRetryAction;
  runClaude: (
    trigger: { reason: AgentTriggerReason; retryAfterMs?: number },
    rotationMessage?: string,
  ) => Promise<'success' | 'error'>;
  runCodex: (
    trigger: { reason: CodexRotationReason },
    rotationMessage?: string,
  ) => Promise<'success' | 'error'>;
}): Promise<ExecutedAttemptRetryAction> {
  if (args.retryAction.kind === 'claude') {
    return {
      kind: 'claude',
      trigger: args.retryAction.trigger,
      rotationMessage: args.retryAction.rotationMessage,
      result: await args.runClaude(
        args.retryAction.trigger,
        args.retryAction.rotationMessage,
      ),
    };
  }

  if (args.retryAction.kind === 'codex') {
    return {
      kind: 'codex',
      trigger: args.retryAction.trigger,
      rotationMessage: args.retryAction.rotationMessage,
      result: await args.runCodex(
        args.retryAction.trigger,
        args.retryAction.rotationMessage,
      ),
    };
  }

  return { kind: 'none' };
}
