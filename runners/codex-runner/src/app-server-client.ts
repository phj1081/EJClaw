import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createRequire } from 'module';
import path from 'path';

import {
  createInitialAppServerTurnState,
  getAppServerTurnResult,
  isAppServerTurnFinished,
  reduceAppServerTurnState,
  type AppServerTurnEvent,
  type AppServerTurnState,
} from './app-server-state.js';

export interface AppServerInputItemText {
  type: 'text';
  text: string;
}

export interface AppServerInputItemLocalImage {
  type: 'localImage';
  path: string;
}

export type AppServerInputItem =
  | AppServerInputItemText
  | AppServerInputItemLocalImage;

export interface CodexAppServerThreadOptions {
  cwd: string;
  model?: string;
}

export interface CodexAppServerTurnOptions {
  cwd: string;
  model?: string;
  effort?: string;
  onProgress?: (message: string) => void;
}

export interface CodexAppServerTurnResult {
  state: AppServerTurnState;
  result: string | null;
}

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export function buildCodexAppServerArgs(args: {
  codexBin: string;
  enableGoals?: boolean;
}): string[] {
  return args.enableGoals === true
    ? [args.codexBin, '--enable', 'goals', 'app-server']
    : [args.codexBin, 'app-server'];
}

function isCodexThreadGoal(value: unknown): value is CodexThreadGoal {
  if (!value || typeof value !== 'object') return false;
  const goal = value as Partial<CodexThreadGoal>;
  return (
    typeof goal.threadId === 'string' &&
    typeof goal.objective === 'string' &&
    typeof goal.status === 'string'
  );
}

function extractOptionalGoalResult(result: unknown): CodexThreadGoal | null {
  const goal = (result as { goal?: unknown } | null)?.goal ?? null;
  if (goal === null) return null;
  if (!isCodexThreadGoal(goal)) {
    throw new Error('Codex app-server returned an invalid goal payload.');
  }
  return goal;
}

function extractGoalResult(result: unknown, method: string): CodexThreadGoal {
  const goal = extractOptionalGoalResult(result);
  if (!goal) {
    throw new Error(`Codex app-server ${method} did not return a goal.`);
  }
  return goal;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcServerRequest extends JsonRpcNotification {
  id: number;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface ActiveTurn {
  threadId: string;
  state: AppServerTurnState;
  onProgress?: (message: string) => void;
  resolve: (value: CodexAppServerTurnResult) => void;
  reject: (reason?: unknown) => void;
}

export interface CodexAppServerClientOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
  enableGoals?: boolean;
}

export class CodexAppServerClient {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (message: string) => void;
  private readonly enableGoals: boolean;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly require = createRequire(import.meta.url);
  private nextId = 1;
  private stdoutBuffer = '';
  private activeTurn: ActiveTurn | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor(options: CodexAppServerClientOptions) {
    this.cwd = options.cwd;
    this.env = options.env || process.env;
    this.log = options.log;
    this.enableGoals = options.enableGoals === true;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    const codexPackagePath = this.require.resolve('@openai/codex/package.json');
    const codexBin = path.join(
      path.dirname(codexPackagePath),
      'bin',
      'codex.js',
    );

    this.proc = spawn(
      process.execPath,
      buildCodexAppServerArgs({
        codexBin,
        enableGoals: this.enableGoals,
      }),
      {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleStdoutLine(trimmed);
      }
    });

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.log(`[app-server] ${trimmed}`);
      }
    });

    this.proc.on('close', (code) => {
      const error = new Error(
        `Codex app-server exited with code ${code ?? 'unknown'}`,
      );
      this.rejectAll(error);
    });

    this.proc.on('error', (error) => {
      this.rejectAll(error);
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'ejclaw_codex_runner',
        title: 'EJClaw Codex Runner',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          'item/agentMessage/delta',
          'item/plan/delta',
          'item/reasoning/textDelta',
          'item/reasoning/summaryTextDelta',
          'item/reasoning/summaryPartAdded',
        ],
      },
    });
    this.notify('initialized', {});
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }

  async startOrResumeThread(
    sessionId: string | undefined,
    options: CodexAppServerThreadOptions,
  ): Promise<string> {
    const params = {
      cwd: options.cwd,
      model: options.model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceName: 'ejclaw',
    };

    const result = sessionId
      ? await this.request('thread/resume', {
          threadId: sessionId,
          ...params,
        })
      : await this.request('thread/start', params);

    const thread = (result as { thread?: { id?: string } }).thread;
    if (!thread?.id) {
      throw new Error('Codex app-server did not return a thread id.');
    }
    return thread.id;
  }

  async startTurn(
    threadId: string,
    input: AppServerInputItem[],
    options: CodexAppServerTurnOptions,
  ): Promise<{
    turnId: string;
    steer: (nextInput: AppServerInputItem[]) => Promise<void>;
    interrupt: () => Promise<void>;
    wait: () => Promise<CodexAppServerTurnResult>;
  }> {
    if (this.activeTurn) {
      throw new Error('A Codex app-server turn is already active.');
    }

    const turnPromise = new Promise<CodexAppServerTurnResult>(
      (resolve, reject) => {
        this.activeTurn = {
          threadId,
          state: createInitialAppServerTurnState(),
          onProgress: options.onProgress,
          resolve,
          reject,
        };
      },
    );

    let turnId = '';
    try {
      const response = (await this.request('turn/start', {
        threadId,
        input,
        cwd: options.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'dangerFullAccess',
          networkAccess: true,
        },
        model: options.model,
        effort: options.effort,
        summary: 'concise',
      })) as { turn?: { id?: string; status?: string } };

      turnId = response.turn?.id || '';
      if (!turnId) {
        throw new Error('Codex app-server did not return a turn id.');
      }

      const activeTurn = this.activeTurn as ActiveTurn | null;
      if (activeTurn !== null) {
        activeTurn.state = reduceAppServerTurnState(activeTurn.state, {
          method: 'turn/started',
          params: {
            turn: {
              id: turnId,
              status: response.turn?.status || 'inProgress',
            },
          },
        });
      }
    } catch (error) {
      this.activeTurn = null;
      throw error;
    }

    return {
      turnId,
      steer: async (nextInput) => {
        await this.request('turn/steer', {
          threadId,
          input: nextInput,
          expectedTurnId: turnId,
        });
      },
      interrupt: async () => {
        await this.request('turn/interrupt', {
          threadId,
          turnId,
        });
      },
      wait: async () => turnPromise,
    };
  }

  async startCompaction(threadId: string): Promise<CodexAppServerTurnResult> {
    if (this.activeTurn) {
      throw new Error('A Codex app-server turn is already active.');
    }

    const turnPromise = new Promise<CodexAppServerTurnResult>(
      (resolve, reject) => {
        this.activeTurn = {
          threadId,
          state: createInitialAppServerTurnState(),
          resolve,
          reject,
        };
      },
    );

    try {
      await this.request('thread/compact/start', { threadId });
    } catch (error) {
      this.activeTurn = null;
      throw error;
    }

    return turnPromise;
  }

  async threadGoalSet(
    threadId: string,
    objective: string,
  ): Promise<CodexThreadGoal> {
    const result = await this.request('thread/goal/set', {
      threadId,
      objective,
    });
    return extractGoalResult(result, 'thread/goal/set');
  }

  async threadGoalGet(threadId: string): Promise<CodexThreadGoal | null> {
    const result = await this.request('thread/goal/get', { threadId });
    return extractOptionalGoalResult(result);
  }

  async threadGoalClear(threadId: string): Promise<boolean> {
    const result = await this.request('thread/goal/clear', { threadId });
    return (result as { cleared?: boolean } | null)?.cleared === true;
  }

  private handleStdoutLine(line: string): void {
    let message: JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;
    try {
      message = JSON.parse(line);
    } catch {
      this.log(`[app-server] non-JSON stdout: ${line}`);
      return;
    }

    if (
      typeof (message as JsonRpcResponse).id === 'number' &&
      ('result' in message || 'error' in message) &&
      !('method' in message)
    ) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }

    if (
      typeof (message as JsonRpcServerRequest).id === 'number' &&
      typeof (message as JsonRpcServerRequest).method === 'string'
    ) {
      this.handleServerRequest(message as JsonRpcServerRequest);
      return;
    }

    if (typeof (message as JsonRpcNotification).method === 'string') {
      this.handleNotification(message as JsonRpcNotification);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(
        new Error(
          message.error.message ||
            `${pending.method} failed with JSON-RPC error ${message.error.code ?? 'unknown'}`,
        ),
      );
      return;
    }

    pending.resolve(message.result);
  }

  private handleServerRequest(message: JsonRpcServerRequest): void {
    if (message.method.endsWith('/requestApproval')) {
      this.respond(message.id, 'acceptForSession');
      return;
    }

    this.respondError(
      message.id,
      -32601,
      `EJClaw does not handle server request ${message.method}`,
    );
  }

  private handleNotification(message: JsonRpcNotification): void {
    if (!this.activeTurn) return;

    if (message.method === 'item/completed') {
      const item =
        (message.params?.item as Record<string, unknown> | undefined) ||
        undefined;
      if (
        item?.type === 'agentMessage' &&
        item.phase !== 'final_answer' &&
        typeof item.text === 'string' &&
        item.text.trim().length > 0
      ) {
        this.activeTurn.onProgress?.(item.text);
      }
    }

    this.activeTurn.state = reduceAppServerTurnState(
      this.activeTurn.state,
      message as AppServerTurnEvent,
    );

    if (!isAppServerTurnFinished(this.activeTurn.state)) {
      return;
    }

    const activeTurn = this.activeTurn;
    this.activeTurn = null;
    activeTurn.resolve({
      state: activeTurn.state,
      result: getAppServerTurnResult(activeTurn.state),
    });
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();

    if (this.activeTurn) {
      const activeTurn = this.activeTurn;
      this.activeTurn = null;
      activeTurn.reject(error);
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write(payload);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  private respond(id: number, result: unknown): void {
    this.write({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  private respondError(id: number, code: number, message: string): void {
    this.write({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable) {
      throw new Error('Codex app-server stdin is not writable.');
    }
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
}
