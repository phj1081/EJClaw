import { query } from '@anthropic-ai/claude-agent-sdk';
import { EJCLAW_ENV, IPC_POLL_MS } from 'ejclaw-runners-shared';

import { compactBoundaryFromMessage } from './compaction-boundary.js';
import { getClaudeCliPath } from './claude-cli.js';
import { drainIpcInput, shouldClose } from './ipc-input.js';
import { buildEjclawMcpServerConfig } from './mcp-config.js';
import {
  MessageStream,
  buildCompactionOutput,
  buildMultimodalContent,
  extractAssistantText,
  normalizeStructuredOutput,
  type RunnerCompaction,
  writeOutput,
} from './output-protocol.js';
import { buildClaudeReadonlySandboxSettings } from './reviewer-runtime.js';
import {
  createPreCompactHook,
  createReviewerBashGuardHook,
  createSanitizeBashHook,
} from './runner-hooks.js';
import type { RunnerInput } from './runner-input.js';
import {
  TopLevelAgentTaskTracker,
  buildTaskNotificationOutput,
  buildTaskProgressOutput,
  buildTaskStartedOutput,
} from './task-progress-mapping.js';

export interface ClaudeQueryPaths {
  groupDir: string;
  groupFolder: string;
  hostTasksDir: string;
  ipcInputCloseSentinel: string;
  ipcInputDir: string;
  workDir: string;
}

export interface RunClaudeQueryArgs {
  prompt: string;
  sessionId: string | undefined;
  mcpServerPath: string;
  runnerInput: RunnerInput;
  sdkEnv: Record<string, string | undefined>;
  reviewerRuntime: boolean;
  claudeReadonlyReviewerRuntime: boolean;
  claudeReadonlySandboxMode: 'strict' | 'best-effort' | null;
  abortController: AbortController;
  paths: ClaudeQueryPaths;
  log: (message: string) => void;
}

export interface ClaudeQueryResult {
  newSessionId?: string;
  closedDuringQuery: boolean;
  terminalResultObserved: boolean;
  compaction?: RunnerCompaction;
}

class ClaudeQueryRunner {
  private readonly stream: MessageStream;
  private readonly trackedAgentTasks = new TopLevelAgentTaskTracker();
  private readonly extraDirs: string[] = [];
  private readonly effectiveCwd: string;
  private ipcPolling = true;
  private closedDuringQuery = false;
  private newSessionId: string | undefined;
  private messageCount = 0;
  private resultCount = 0;
  private terminalResultObserved = false;
  private pendingProgressText: string | null = null;
  private compaction: RunnerCompaction | undefined;

  constructor(private readonly args: RunClaudeQueryArgs) {
    this.stream = new MessageStream((text) =>
      buildMultimodalContent(text, args.log),
    );
    this.effectiveCwd = args.paths.workDir || args.paths.groupDir;
    if (args.paths.workDir && args.paths.workDir !== args.paths.groupDir) {
      this.extraDirs.push(args.paths.groupDir);
      args.log(
        `Work directory override: ${args.paths.workDir} (group dir added to additionalDirectories)`,
      );
    }
    if (this.extraDirs.length > 0) {
      args.log(`Additional directories: ${this.extraDirs.join(', ')}`);
    }
  }

  async run(): Promise<ClaudeQueryResult> {
    this.stream.push(this.args.prompt);
    this.startIpcPolling();
    this.logRuntimeConfig();

    for await (const message of query({
      prompt: this.stream,
      options: this.buildQueryOptions(),
    })) {
      this.messageCount++;
      const msgType =
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: string }).type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : (message as { type?: string }).type;
      this.args.log(`[msg #${this.messageCount}] type=${msgType}`);

      if (this.handleMessage(message)) break;
    }

    this.flushRemainingPendingText();
    this.ipcPolling = false;
    this.args.log(
      `Query done. Messages: ${this.messageCount}, results: ${this.resultCount}, closedDuringQuery: ${this.closedDuringQuery}`,
    );
    return {
      newSessionId: this.newSessionId,
      closedDuringQuery: this.closedDuringQuery,
      terminalResultObserved: this.terminalResultObserved,
      compaction: this.compaction,
    };
  }

  private startIpcPolling(): void {
    const pollIpcDuringQuery = () => {
      if (!this.ipcPolling) return;
      if (shouldClose(this.args.paths.ipcInputCloseSentinel)) {
        this.handleCloseSentinel();
        return;
      }
      const messages = drainIpcInput(
        this.args.paths.ipcInputDir,
        this.args.log,
      );
      for (const text of messages) {
        this.args.log(
          `Piping IPC message into active query (${text.length} chars)`,
        );
        this.stream.push(text);
      }
      setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
    };
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  }

  private handleCloseSentinel(): void {
    this.args.log('Close sentinel detected during query, ending stream');
    if (this.pendingProgressText && !this.terminalResultObserved) {
      this.args.log(
        `Flushing pending text before close (${this.pendingProgressText.length} chars)`,
      );
      writeOutput({
        status: 'success',
        ...normalizeStructuredOutput(this.pendingProgressText),
        newSessionId: this.newSessionId,
      });
      this.pendingProgressText = null;
      this.terminalResultObserved = true;
      this.resultCount++;
    }
    this.closedDuringQuery = true;
    this.stream.end();
    this.ipcPolling = false;
  }

  private buildQueryOptions() {
    const readonlyReviewerRuntime =
      this.args.reviewerRuntime || this.args.claudeReadonlyReviewerRuntime;
    const readonlyProtectedPaths = [
      this.effectiveCwd,
      ...this.extraDirs,
    ].filter((value): value is string => Boolean(value));
    const claudeReadonlySandboxSettings =
      this.args.claudeReadonlyReviewerRuntime &&
      this.args.claudeReadonlySandboxMode
        ? buildClaudeReadonlySandboxSettings(
            readonlyProtectedPaths,
            undefined,
            this.args.claudeReadonlySandboxMode,
          )
        : undefined;

    return {
      pathToClaudeCodeExecutable: getClaudeCliPath(this.args.log),
      cwd: this.effectiveCwd,
      model: this.resolveModel(),
      thinking: this.resolveThinking(),
      effort: this.resolveEffort(),
      additionalDirectories:
        this.extraDirs.length > 0 ? this.extraDirs : undefined,
      resume: this.args.sessionId,
      allowedTools: this.buildAllowedTools(readonlyReviewerRuntime),
      env: this.args.sdkEnv,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      ...(claudeReadonlySandboxSettings
        ? { sandbox: claudeReadonlySandboxSettings }
        : {}),
      settingSources: ['project', 'user'] as ('project' | 'user')[],
      abortController: this.args.abortController,
      mcpServers: {
        ejclaw: buildEjclawMcpServerConfig(this.args.mcpServerPath, {
          chatJid: this.args.runnerInput.chatJid,
          groupFolder: this.args.runnerInput.groupFolder,
          isMain: this.args.runnerInput.isMain,
          agentType: process.env[EJCLAW_ENV.agentType] || 'claude-code',
          roomRole: this.args.runnerInput.roomRoleContext?.role || '',
          ipcDir: process.env[EJCLAW_ENV.ipcDir],
          hostIpcDir: process.env[EJCLAW_ENV.hostIpcDir],
        }),
      },
      hooks: {
        PreCompact: [
          {
            hooks: [
              createPreCompactHook({
                assistantName: this.args.runnerInput.assistantName,
                groupDir: this.args.paths.groupDir,
                groupFolder: this.args.paths.groupFolder,
                hostTasksDir: this.args.paths.hostTasksDir,
                log: this.args.log,
                writeOutput,
              }),
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: readonlyReviewerRuntime
              ? [createReviewerBashGuardHook(), createSanitizeBashHook()]
              : [createSanitizeBashHook()],
          },
        ],
      },
      agentProgressSummaries: true,
    };
  }

  private logRuntimeConfig(): void {
    const model = this.resolveModel();
    const thinking = this.resolveThinking();
    const effort = this.resolveEffort();
    if (model) this.args.log(`Using model: ${model}`);
    if (thinking) this.args.log(`Thinking config: ${JSON.stringify(thinking)}`);
    if (effort) this.args.log(`Effort: ${effort}`);
    if (this.args.reviewerRuntime) {
      this.args.log('Reviewer runtime restrictions enabled');
    }
    if (this.args.claudeReadonlyReviewerRuntime) {
      this.args.log(
        `Claude host reviewer read-only sandbox enabled (${this.args.claudeReadonlySandboxMode || 'unknown'})`,
      );
    }
    if (this.args.claudeReadonlySandboxMode === 'best-effort') {
      this.args.log(
        'Claude host reviewer sandbox capability unavailable on this host, using best-effort read-only mode',
      );
    }
  }

  private resolveModel(): string | undefined {
    return process.env.CLAUDE_MODEL || undefined;
  }

  private resolveThinking():
    | { type: 'adaptive' }
    | { type: 'enabled'; budgetTokens?: number }
    | { type: 'disabled' }
    | undefined {
    const thinkingType = process.env.CLAUDE_THINKING || undefined;
    const thinkingBudget = process.env.CLAUDE_THINKING_BUDGET
      ? parseInt(process.env.CLAUDE_THINKING_BUDGET, 10)
      : undefined;
    return thinkingType === 'adaptive'
      ? { type: 'adaptive' }
      : thinkingType === 'enabled'
        ? { type: 'enabled', budgetTokens: thinkingBudget }
        : thinkingType === 'disabled'
          ? { type: 'disabled' }
          : undefined;
  }

  private resolveEffort(): 'low' | 'medium' | 'high' | 'max' | undefined {
    return (
      (process.env.CLAUDE_EFFORT as 'low' | 'medium' | 'high' | 'max') ||
      undefined
    );
  }

  private buildAllowedTools(readonlyRuntime: boolean): string[] {
    const readonlyTools = [
      'Bash',
      'Read',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
      'Task',
      'TaskOutput',
      'TaskStop',
      'TeamCreate',
      'TeamDelete',
      'SendMessage',
      'TodoWrite',
      'ToolSearch',
      'Skill',
      'mcp__ejclaw__*',
    ];
    const writeTools = [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
      'Task',
      'TaskOutput',
      'TaskStop',
      'TeamCreate',
      'TeamDelete',
      'SendMessage',
      'TodoWrite',
      'ToolSearch',
      'Skill',
      'NotebookEdit',
      'mcp__ejclaw__*',
    ];
    return readonlyRuntime ? readonlyTools : writeTools;
  }

  private handleMessage(message: unknown): boolean {
    const type = (message as { type?: string }).type;
    if (type !== 'assistant' && this.pendingProgressText) {
      this.flushPendingProgressAsIntermediate();
    }
    if (type === 'system') this.handleSystemMessage(message);
    if (type === 'tool_progress') this.handleToolProgress(message);
    if (type === 'tool_use_summary') this.handleToolUseSummary(message);
    if (type === 'result') return this.handleResultMessage(message);
    if (type === 'assistant') return this.handleAssistantMessage(message);
    return false;
  }

  private handleSystemMessage(message: unknown): void {
    const subtype = (message as { subtype?: string }).subtype;
    if (subtype === 'init') {
      this.newSessionId = (message as { session_id?: string }).session_id;
      this.args.log(`Session initialized: ${this.newSessionId}`);
    }

    this.compaction =
      compactBoundaryFromMessage(message, this.args.log) ?? this.compaction;

    if (subtype === 'task_notification') {
      const tn = message as {
        task_id: string;
        tool_use_id?: string;
        status: string;
        summary: string;
      };
      this.args.log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
      const mapped = buildTaskNotificationOutput(
        this.trackedAgentTasks,
        tn,
        this.newSessionId,
      );
      if (mapped) writeOutput(mapped);
    }

    if (subtype === 'task_progress') {
      const tp = message as Record<string, unknown>;
      const description =
        typeof tp.description === 'string' ? tp.description : '';
      const mapped = buildTaskProgressOutput(
        this.trackedAgentTasks,
        tp,
        this.newSessionId,
      );
      if (mapped) {
        writeOutput(mapped);
      } else if (description) {
        this.args.log(
          `Skipping long task_progress description (${description.length} chars)`,
        );
      }
    }

    if (subtype === 'task_started') {
      const ts = message as { task_id: string; description?: string };
      const desc = ts.description || '';
      this.args.log(
        `Subagent started: task=${ts.task_id} desc=${desc.slice(0, 200)}`,
      );
      const mapped = buildTaskStartedOutput(
        this.trackedAgentTasks,
        ts,
        this.newSessionId,
      );
      if (mapped) writeOutput(mapped);
    }
  }

  private handleToolProgress(message: unknown): void {
    const tp = message as {
      tool_name: string;
      elapsed_time_seconds: number;
    };
    const label = `${tp.tool_name} (${Math.round(tp.elapsed_time_seconds)}s)`;
    this.args.log(`Tool progress: ${label}`);
    writeOutput({
      status: 'success',
      phase: 'progress',
      ...normalizeStructuredOutput(label),
      newSessionId: this.newSessionId,
    });
  }

  private handleToolUseSummary(message: unknown): void {
    const ts = message as { summary: string };
    this.args.log(`Tool use summary: ${ts.summary.slice(0, 200)}`);
    writeOutput({
      status: 'success',
      phase: 'progress',
      ...normalizeStructuredOutput(ts.summary),
      newSessionId: this.newSessionId,
    });
  }

  private handleResultMessage(message: unknown): boolean {
    const resultMessage = message as {
      subtype?: string;
      result?: string;
      errors?: unknown;
      stop_reason?: unknown;
      duration_ms?: unknown;
      duration_api_ms?: unknown;
      session_id?: unknown;
    };
    this.resultCount++;
    let textResult = resultMessage.result || null;
    const isError = resultMessage.subtype?.startsWith('error');

    if (this.pendingProgressText && textResult === this.pendingProgressText) {
      this.args.log('Discarding pending progress (matches result)');
      this.pendingProgressText = null;
    } else if (this.pendingProgressText) {
      if (!textResult) {
        this.args.log(
          `Promoting pending progress text to result (${this.pendingProgressText.length} chars)`,
        );
        textResult = this.pendingProgressText;
      } else {
        writeOutput({
          status: 'success',
          phase: 'intermediate',
          result: this.pendingProgressText,
          newSessionId: this.newSessionId,
        });
      }
      this.pendingProgressText = null;
    }

    this.args.log(
      `Result #${this.resultCount}: subtype=${resultMessage.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
    );
    if (isError) {
      this.writeErrorResult(resultMessage, textResult);
    } else {
      this.writeSuccessResult(textResult);
    }
    this.terminalResultObserved = true;
    this.ipcPolling = false;
    this.stream.end();
    this.args.log('Terminal result observed, ending query stream');
    return true;
  }

  private writeErrorResult(
    message: {
      subtype?: string;
      errors?: unknown;
      stop_reason?: unknown;
      duration_ms?: unknown;
      duration_api_ms?: unknown;
      session_id?: unknown;
    },
    textResult: string | null,
  ): void {
    const sdkErrors = Array.isArray(message.errors)
      ? (message.errors as string[])
      : [];
    this.args.log(
      `Error result detail: ${JSON.stringify({
        subtype: message.subtype,
        result: textResult?.slice(0, 500),
        errors: sdkErrors,
        stop_reason: message.stop_reason,
        duration_ms: message.duration_ms,
        duration_api_ms: message.duration_api_ms,
        session_id: message.session_id,
      })}`,
    );
    writeOutput({
      status: 'error',
      result: textResult || null,
      newSessionId: this.newSessionId,
      error:
        sdkErrors.length > 0
          ? sdkErrors.join('; ')
          : `Agent error: ${message.subtype}`,
      ...buildCompactionOutput(this.compaction),
    });
  }

  private writeSuccessResult(textResult: string | null): void {
    writeOutput({
      status: 'success',
      ...normalizeStructuredOutput(textResult || null),
      newSessionId: this.newSessionId,
      ...buildCompactionOutput(this.compaction),
    });
  }

  private handleAssistantMessage(message: unknown): boolean {
    this.trackedAgentTasks.rememberAssistantMessage(message);
    const stopReason = (message as { stop_reason?: string }).stop_reason;
    const textResult = extractAssistantText(message);
    if (textResult || stopReason === 'end_turn') {
      this.args.log(
        `Assistant: stop=${stopReason} text=${textResult ? textResult.length + ' chars' : 'null'}`,
      );
    }
    if (stopReason === 'end_turn' && textResult) {
      this.resultCount++;
      this.args.log(
        `Terminal assistant turn observed without result event (${textResult.length} chars), ending query stream`,
      );
      writeOutput({
        status: 'success',
        ...normalizeStructuredOutput(textResult),
        newSessionId: this.newSessionId,
        ...buildCompactionOutput(this.compaction),
      });
      this.terminalResultObserved = true;
      this.ipcPolling = false;
      this.stream.end();
      return true;
    }
    if (stopReason !== 'end_turn' && textResult) {
      if (this.pendingProgressText) this.flushPendingProgressAsIntermediate();
      this.pendingProgressText = textResult;
      this.args.log(
        `Intermediate assistant text buffered (${textResult.length} chars, stop=${stopReason})`,
      );
    }
    return false;
  }

  private flushPendingProgressAsIntermediate(): void {
    if (!this.pendingProgressText) return;
    writeOutput({
      status: 'success',
      phase: 'intermediate',
      ...normalizeStructuredOutput(this.pendingProgressText),
      newSessionId: this.newSessionId,
    });
    this.pendingProgressText = null;
  }

  private flushRemainingPendingText(): void {
    if (!this.pendingProgressText || this.terminalResultObserved) return;
    this.args.log(
      `Flushing remaining pending progress text as final output (${this.pendingProgressText.length} chars)`,
    );
    writeOutput({
      status: 'success',
      ...normalizeStructuredOutput(this.pendingProgressText),
      newSessionId: this.newSessionId,
      ...buildCompactionOutput(this.compaction),
    });
    this.terminalResultObserved = true;
    this.resultCount++;
  }
}

export function runClaudeQuery(
  args: RunClaudeQueryArgs,
): Promise<ClaudeQueryResult> {
  return new ClaudeQueryRunner(args).run();
}
