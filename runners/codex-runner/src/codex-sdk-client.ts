import {
  Codex,
  type CodexOptions,
  type Input,
  type ModelReasoningEffort,
  type ThreadEvent,
  type ThreadOptions,
  type Usage,
  type UserInput,
} from '@openai/codex-sdk';

import type { AppServerInputItem } from './app-server-client.js';

export interface CodexSdkThreadPort {
  id: string | null;
  runStreamed(
    input: Input | unknown,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<ThreadEvent | unknown> }>;
}

export interface CodexSdkPort {
  startThread(options?: ThreadOptions): CodexSdkThreadPort;
  resumeThread(id: string, options?: ThreadOptions): CodexSdkThreadPort;
}

export interface CodexSdkClientOptions {
  codex?: CodexSdkPort;
  env?: Record<string, string>;
  log: (message: string) => void;
  codexPathOverride?: string;
  config?: CodexOptions['config'];
}

export interface CodexSdkThreadStartOptions {
  cwd: string;
  model?: string;
  effort?: string;
}

export interface CodexSdkTurnOptions extends CodexSdkThreadStartOptions {
  onProgress?: (message: string) => void;
}

export interface CodexSdkTurnState {
  status: 'pending' | 'inProgress' | 'completed' | 'failed' | 'interrupted';
  threadId: string | null;
  finalAnswer: string | null;
  latestAgentMessage: string | null;
  errorMessage: string | null;
  usage: Usage | null;
}

export interface CodexSdkTurnResult {
  state: CodexSdkTurnState;
  result: string | null;
  threadId: string | null;
}

export function createInitialCodexSdkTurnState(): CodexSdkTurnState {
  return {
    status: 'pending',
    threadId: null,
    finalAnswer: null,
    latestAgentMessage: null,
    errorMessage: null,
    usage: null,
  };
}

function isKnownReasoningEffort(
  effort: string | undefined,
): effort is ModelReasoningEffort {
  return (
    effort === 'minimal' ||
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh'
  );
}

function normalizeReasoningEffort(
  effort: string | undefined,
): ModelReasoningEffort | undefined {
  if (effort === 'minimal') {
    return 'low';
  }
  return isKnownReasoningEffort(effort) ? effort : undefined;
}

function buildThreadOptions(
  options: CodexSdkThreadStartOptions,
): ThreadOptions {
  return {
    approvalPolicy: 'never',
    model: options.model,
    modelReasoningEffort: normalizeReasoningEffort(options.effort),
    networkAccessEnabled: true,
    sandboxMode: 'danger-full-access',
    workingDirectory: options.cwd,
  };
}

export function toCodexSdkInput(input: AppServerInputItem[]): UserInput[] {
  return input.map((item) => {
    if (item.type === 'text') {
      return { type: 'text', text: item.text };
    }
    return { type: 'local_image', path: item.path };
  });
}

export function reduceCodexSdkTurnState(
  state: CodexSdkTurnState,
  event: ThreadEvent | unknown,
): CodexSdkTurnState {
  if (!event || typeof event !== 'object' || !('type' in event)) {
    return state;
  }

  const typed = event as ThreadEvent;
  if (typed.type === 'thread.started') {
    return { ...state, threadId: typed.thread_id };
  }

  if (typed.type === 'turn.started') {
    return { ...state, status: 'inProgress' };
  }

  if (typed.type === 'item.completed') {
    if (typed.item.type === 'agent_message') {
      const text = typed.item.text.trim();
      if (!text) return state;
      return {
        ...state,
        finalAnswer: text,
        latestAgentMessage: text,
      };
    }
    if (typed.item.type === 'error') {
      return {
        ...state,
        errorMessage: typed.item.message,
      };
    }
    return state;
  }

  if (typed.type === 'turn.completed') {
    return {
      ...state,
      status: state.status === 'failed' ? 'failed' : 'completed',
      usage: typed.usage,
    };
  }

  if (typed.type === 'turn.failed') {
    return {
      ...state,
      status: 'failed',
      errorMessage: typed.error.message,
    };
  }

  if (typed.type === 'error') {
    return {
      ...state,
      status: 'failed',
      errorMessage: typed.message,
    };
  }

  return state;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.message.toLowerCase().includes('abort'))
  );
}

export class CodexSdkClient {
  private readonly codex: CodexSdkPort;
  private readonly log: (message: string) => void;
  private readonly threads = new Map<string, CodexSdkThreadPort>();
  private nextPendingThreadId = 1;

  constructor(options: CodexSdkClientOptions) {
    this.log = options.log;
    this.codex =
      options.codex ??
      new Codex({
        codexPathOverride: options.codexPathOverride,
        config: options.config,
        env: options.env,
      });
  }

  async startOrResumeThread(
    sessionId: string | undefined,
    options: CodexSdkThreadStartOptions,
  ): Promise<string> {
    const threadOptions = buildThreadOptions(options);
    const thread = sessionId
      ? this.codex.resumeThread(sessionId, threadOptions)
      : this.codex.startThread(threadOptions);
    const handle =
      sessionId ?? `pending-sdk-thread-${this.nextPendingThreadId++}`;
    this.threads.set(handle, thread);
    return handle;
  }

  async startTurn(
    threadHandle: string,
    input: AppServerInputItem[],
    options: CodexSdkTurnOptions,
  ): Promise<{
    turnId: string;
    steer: (nextInput: AppServerInputItem[]) => Promise<void>;
    interrupt: () => Promise<void>;
    wait: () => Promise<CodexSdkTurnResult>;
  }> {
    const thread = this.threads.get(threadHandle);
    if (!thread) {
      throw new Error(`Unknown Codex SDK thread handle: ${threadHandle}`);
    }

    const abortController = new AbortController();
    const waitPromise = this.consumeTurn(
      threadHandle,
      thread,
      input,
      options,
      abortController.signal,
    );

    return {
      turnId: threadHandle,
      steer: async () => {
        throw new Error(
          'Codex SDK runner does not support mid-turn steering; queue the message for the next turn.',
        );
      },
      interrupt: async () => {
        abortController.abort();
      },
      wait: async () => waitPromise,
    };
  }

  private async consumeTurn(
    threadHandle: string,
    thread: CodexSdkThreadPort,
    input: AppServerInputItem[],
    options: CodexSdkTurnOptions,
    signal: AbortSignal,
  ): Promise<CodexSdkTurnResult> {
    let state = createInitialCodexSdkTurnState();
    try {
      const { events } = await thread.runStreamed(toCodexSdkInput(input), {
        signal,
      });
      for await (const event of events) {
        state = reduceCodexSdkTurnState(state, event);
        if (state.threadId && state.threadId !== threadHandle) {
          this.threads.set(state.threadId, thread);
          this.threads.delete(threadHandle);
        }
        if (
          state.latestAgentMessage &&
          state.latestAgentMessage !== state.finalAnswer
        ) {
          options.onProgress?.(state.latestAgentMessage);
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        state = { ...state, status: 'interrupted' };
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Codex SDK turn failed: ${message}`);
        state = { ...state, status: 'failed', errorMessage: message };
      }
    }

    const threadId = state.threadId ?? thread.id;
    if (threadId && threadId !== threadHandle) {
      this.threads.set(threadId, thread);
      this.threads.delete(threadHandle);
    }

    return {
      state: { ...state, threadId },
      result: state.finalAnswer,
      threadId,
    };
  }
}
