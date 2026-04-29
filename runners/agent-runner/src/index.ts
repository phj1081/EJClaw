/**
 * EJClaw Agent Runner
 * Runs as a child process, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full RunnerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to $EJCLAW_IPC_DIR/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  IPC_CLOSE_SENTINEL,
  IPC_INPUT_SUBDIR,
  IPC_POLL_MS,
} from 'ejclaw-runners-shared';
import { fileURLToPath } from 'url';

import { resolveBundledClaudeCodeExecutable } from './bundled-cli-path.js';
import {
  prependRoomRoleHeader,
  type RoomRoleContext,
} from './room-role-context.js';
import {
  assertReadonlyWorkspaceRepoConnectivity,
  buildClaudeReadonlySandboxSettings,
  buildReviewerGitGuardEnv,
  getClaudeReadonlySandboxMode,
  isArbiterRuntimeEnvEnabled,
  isClaudeReadonlyReviewerRuntime,
  isReviewerRuntime,
  isReviewerRuntimeEnvEnabled,
} from './reviewer-runtime.js';
import { drainIpcInput, shouldClose } from './ipc-input.js';
import {
  MessageStream,
  buildMultimodalContent,
  extractAssistantText,
  normalizeStructuredOutput,
  readStdin,
  writeOutput,
} from './output-protocol.js';
import {
  TopLevelAgentTaskTracker,
  buildTaskNotificationOutput,
  buildTaskProgressOutput,
  buildTaskStartedOutput,
} from './task-progress-mapping.js';
import {
  createPreCompactHook,
  createReviewerBashGuardHook,
  createSanitizeBashHook,
} from './runner-hooks.js';

interface RunnerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  roomRoleContext?: RoomRoleContext;
}

// Paths configurable via env vars.
const GROUP_DIR = process.env.EJCLAW_GROUP_DIR || '/workspace/group';
const IPC_DIR = process.env.EJCLAW_IPC_DIR || '/workspace/ipc';
const HOST_IPC_DIR = process.env.EJCLAW_HOST_IPC_DIR || IPC_DIR;
// Optional: override cwd (agent works in this directory instead of GROUP_DIR)
const WORK_DIR = process.env.EJCLAW_WORK_DIR || '';
const GROUP_FOLDER = process.env.EJCLAW_GROUP_FOLDER || '';

const IPC_INPUT_DIR = path.join(IPC_DIR, IPC_INPUT_SUBDIR);
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, IPC_CLOSE_SENTINEL);
const HOST_TASKS_DIR = path.join(HOST_IPC_DIR, 'tasks');

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// 번들 CLI binary를 명시해야 SDK가 musl/glibc 잘못 탐색하는 걸 우회함.
// (SDK 0.2.114의 W7() 헬퍼는 linux-x64-musl를 linux-x64보다 먼저 시도하므로
// glibc 호스트에서 musl 패키지가 빈 껍데기로 설치돼 있으면 실패한다.)
let cachedClaudeCliPath: string | null = null;
function getClaudeCliPath(): string {
  if (cachedClaudeCliPath) return cachedClaudeCliPath;
  cachedClaudeCliPath = resolveBundledClaudeCodeExecutable();
  log(`Resolved bundled Claude Code CLI: ${cachedClaudeCliPath}`);
  return cachedClaudeCliPath;
}

// Graceful shutdown: SIGTERM → abort SDK query, allowing cleanup
const agentAbortController = new AbortController();
process.on('SIGTERM', () => {
  log('Received SIGTERM, aborting agent query...');
  agentAbortController.abort();
});

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  runnerInput: RunnerInput,
  sdkEnv: Record<string, string | undefined>,
  reviewerRuntime: boolean,
  claudeReadonlyReviewerRuntime: boolean,
  claudeReadonlySandboxMode: 'strict' | 'best-effort' | null,
): Promise<{
  newSessionId?: string;
  closedDuringQuery: boolean;
  terminalResultObserved: boolean;
}> {
  const stream = new MessageStream((text) => buildMultimodalContent(text, log));
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose(IPC_INPUT_CLOSE_SENTINEL)) {
      log('Close sentinel detected during query, ending stream');
      // Flush any buffered text before closing — the for-await loop may not
      // reach the post-loop flush code after stream.end().
      if (pendingProgressText && !terminalResultObserved) {
        log(
          `Flushing pending text before close (${pendingProgressText.length} chars)`,
        );
        writeOutput({
          status: 'success',
          ...normalizeStructuredOutput(pendingProgressText),
          newSessionId,
        });
        pendingProgressText = null;
        terminalResultObserved = true;
        resultCount++;
      }
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput(IPC_INPUT_DIR, log);
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let terminalResultObserved = false;
  let pendingProgressText: string | null = null;
  const trackedAgentTasks = new TopLevelAgentTaskTracker();

  // Discover additional directories
  const extraDirs: string[] = [];

  // When WORK_DIR is set, use it as cwd and include GROUP_DIR as additional directory
  const effectiveCwd = WORK_DIR || GROUP_DIR;
  if (WORK_DIR && WORK_DIR !== GROUP_DIR) {
    extraDirs.push(GROUP_DIR);
    log(
      `Work directory override: ${WORK_DIR} (group dir added to additionalDirectories)`,
    );
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Model and thinking configuration from environment
  const model = process.env.CLAUDE_MODEL || undefined;
  const thinkingType = process.env.CLAUDE_THINKING || undefined; // 'adaptive' | 'enabled' | 'disabled'
  const thinkingBudget = process.env.CLAUDE_THINKING_BUDGET
    ? parseInt(process.env.CLAUDE_THINKING_BUDGET, 10)
    : undefined;
  const effort =
    (process.env.CLAUDE_EFFORT as 'low' | 'medium' | 'high' | 'max') ||
    undefined;
  const thinking =
    thinkingType === 'adaptive'
      ? { type: 'adaptive' as const }
      : thinkingType === 'enabled'
        ? { type: 'enabled' as const, budgetTokens: thinkingBudget }
        : thinkingType === 'disabled'
          ? { type: 'disabled' as const }
          : undefined;

  if (model) log(`Using model: ${model}`);
  if (thinking) log(`Thinking config: ${JSON.stringify(thinking)}`);
  if (effort) log(`Effort: ${effort}`);
  if (reviewerRuntime) log('Reviewer runtime restrictions enabled');
  if (claudeReadonlyReviewerRuntime) {
    log(
      `Claude host reviewer read-only sandbox enabled (${claudeReadonlySandboxMode || 'unknown'})`,
    );
  }
  if (claudeReadonlySandboxMode === 'best-effort') {
    log(
      'Claude host reviewer sandbox capability unavailable on this host, using best-effort read-only mode',
    );
  }

  const readonlyReviewerRuntime =
    reviewerRuntime || claudeReadonlyReviewerRuntime;
  const allowedTools = readonlyReviewerRuntime
    ? [
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
      ]
    : [
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

  const readonlyProtectedPaths = [effectiveCwd, ...extraDirs].filter(
    (value): value is string => Boolean(value),
  );
  const claudeReadonlySandboxSettings =
    claudeReadonlyReviewerRuntime && claudeReadonlySandboxMode
      ? buildClaudeReadonlySandboxSettings(
          readonlyProtectedPaths,
          undefined,
          claudeReadonlySandboxMode,
        )
      : undefined;

  for await (const message of query({
    prompt: stream,
    options: {
      // 번들 CLI binary를 명시해야 SDK가 musl/glibc 잘못 탐색하는 걸 우회함.
      pathToClaudeCodeExecutable: getClaudeCliPath(),
      cwd: effectiveCwd,
      model,
      thinking,
      effort,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      allowedTools,
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(claudeReadonlySandboxSettings
        ? {
            sandbox: claudeReadonlySandboxSettings,
          }
        : {}),
      settingSources: ['project', 'user'],
      abortController: agentAbortController,
      mcpServers: {
        ejclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            EJCLAW_CHAT_JID: runnerInput.chatJid,
            EJCLAW_GROUP_FOLDER: runnerInput.groupFolder,
            EJCLAW_IS_MAIN: runnerInput.isMain ? '1' : '0',
            EJCLAW_AGENT_TYPE: process.env.EJCLAW_AGENT_TYPE || 'claude-code',
            EJCLAW_ROOM_ROLE: runnerInput.roomRoleContext?.role || '',
            ...(process.env.EJCLAW_IPC_DIR && {
              EJCLAW_IPC_DIR: process.env.EJCLAW_IPC_DIR,
            }),
            ...(process.env.EJCLAW_HOST_IPC_DIR && {
              EJCLAW_HOST_IPC_DIR: process.env.EJCLAW_HOST_IPC_DIR,
            }),
          },
        },
      },
      hooks: {
        PreCompact: [
          {
            hooks: [
              createPreCompactHook({
                assistantName: runnerInput.assistantName,
                groupDir: GROUP_DIR,
                groupFolder: GROUP_FOLDER,
                hostTasksDir: HOST_TASKS_DIR,
                log,
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
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    // Flush pending intermediate text as a regular message on non-assistant events.
    if (message.type !== 'assistant' && pendingProgressText) {
      writeOutput({
        status: 'success',
        phase: 'intermediate',
        ...normalizeStructuredOutput(pendingProgressText),
        newSessionId,
      });
      pendingProgressText = null;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'compact_boundary'
    ) {
      const meta = (
        message as {
          compact_metadata?: { trigger?: string; pre_tokens?: number };
        }
      ).compact_metadata;
      log(
        `Compact boundary — trigger=${meta?.trigger || '?'} pre_tokens=${meta?.pre_tokens ?? '?'}`,
      );
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        tool_use_id?: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
      const mapped = buildTaskNotificationOutput(
        trackedAgentTasks,
        tn,
        newSessionId,
      );
      if (mapped) {
        writeOutput(mapped);
      }
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_progress'
    ) {
      const tp = message as Record<string, unknown>;
      const description =
        typeof tp.description === 'string' ? tp.description : '';
      const mapped = buildTaskProgressOutput(
        trackedAgentTasks,
        tp,
        newSessionId,
      );
      if (mapped) {
        writeOutput(mapped);
      } else if (description) {
        // Long AI summary → skip (too long for progress sub-line)
        log(
          `Skipping long task_progress description (${description.length} chars)`,
        );
      }
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_started'
    ) {
      const ts = message as { task_id: string; description?: string };
      const desc = ts.description || '';
      log(`Subagent started: task=${ts.task_id} desc=${desc.slice(0, 200)}`);
      const mapped = buildTaskStartedOutput(
        trackedAgentTasks,
        ts,
        newSessionId,
      );
      if (mapped) {
        writeOutput(mapped);
      }
    }

    if (message.type === 'tool_progress') {
      const tp = message as {
        tool_name: string;
        elapsed_time_seconds: number;
      };
      const label = `${tp.tool_name} (${Math.round(tp.elapsed_time_seconds)}s)`;
      log(`Tool progress: ${label}`);
      const normalized = normalizeStructuredOutput(label);
      writeOutput({
        status: 'success',
        phase: 'progress',
        ...normalized,
        newSessionId,
      });
    }

    if (message.type === 'tool_use_summary') {
      const ts = message as { summary: string };
      log(`Tool use summary: ${ts.summary.slice(0, 200)}`);
      const normalized = normalizeStructuredOutput(ts.summary);
      writeOutput({
        status: 'success',
        phase: 'progress',
        ...normalized,
        newSessionId,
      });
    }

    if (message.type === 'result') {
      resultCount++;
      let textResult =
        'result' in message ? (message as { result?: string }).result : null;
      const isError = message.subtype?.startsWith('error');
      // Discard pending progress if it matches the final result (prevent duplicate)
      if (
        pendingProgressText &&
        textResult &&
        pendingProgressText === textResult
      ) {
        log(`Discarding pending progress (matches result)`);
        pendingProgressText = null;
      } else if (pendingProgressText) {
        // If the result has no text, promote pending progress to the result
        // so it gets delivered as the final output instead of being lost.
        if (!textResult) {
          log(
            `Promoting pending progress text to result (${pendingProgressText.length} chars)`,
          );
          textResult = pendingProgressText;
        } else {
          writeOutput({
            status: 'success',
            phase: 'intermediate',
            result: pendingProgressText,
            newSessionId,
          });
        }
        pendingProgressText = null;
      }
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );
      if (isError) {
        // Log full error details for debugging
        const msg = message as Record<string, unknown>;
        const sdkErrors = Array.isArray(msg.errors)
          ? (msg.errors as string[])
          : [];
        const errorDetail = JSON.stringify({
          subtype: message.subtype,
          result: textResult?.slice(0, 500),
          errors: sdkErrors,
          stop_reason: msg.stop_reason,
          duration_ms: msg.duration_ms,
          duration_api_ms: msg.duration_api_ms,
          session_id: msg.session_id,
        });
        log(`Error result detail: ${errorDetail}`);
        // Pass SDK errors through so host can detect session issues
        const errorText =
          sdkErrors.length > 0 ? sdkErrors.join('; ') : undefined;
        writeOutput({
          status: 'error',
          result: textResult || null,
          newSessionId,
          error: errorText || `Agent error: ${message.subtype}`,
        });
      } else {
        const normalized = normalizeStructuredOutput(textResult || null);
        writeOutput({
          status: 'success',
          ...normalized,
          newSessionId,
        });
      }

      // Single-turn runtimes must terminate the query after the first
      // terminal result. Leaving the message stream open can keep the SDK
      // query alive indefinitely, which pins the host queue after a reply.
      terminalResultObserved = true;
      ipcPolling = false;
      stream.end();
      log('Terminal result observed, ending query stream');
      break;
    }

    if (message.type === 'assistant') {
      trackedAgentTasks.rememberAssistantMessage(message);
      const stopReason = (message as { stop_reason?: string }).stop_reason;
      const textResult = extractAssistantText(message);
      // Only log when there's something interesting (text or terminal)
      if (textResult || stopReason === 'end_turn') {
        log(
          `Assistant: stop=${stopReason} text=${textResult ? textResult.length + ' chars' : 'null'}`,
        );
      }
      if (stopReason === 'end_turn' && textResult) {
        resultCount++;
        log(
          `Terminal assistant turn observed without result event (${textResult.length} chars), ending query stream`,
        );
        writeOutput({
          status: 'success',
          ...normalizeStructuredOutput(textResult),
          newSessionId,
        });
        terminalResultObserved = true;
        ipcPolling = false;
        stream.end();
        break;
      }
      // Intermediate assistant text between tool calls → buffer as pending progress.
      // Don't emit immediately — if the next message is a result with the same text,
      // this would cause a duplicate. The pending text is flushed when the next
      // non-result message arrives, or discarded if result matches.
      if (stopReason !== 'end_turn' && textResult) {
        // Flush previous pending as a regular message (not progress heading)
        if (pendingProgressText) {
          const normalized = normalizeStructuredOutput(pendingProgressText);
          writeOutput({
            status: 'success',
            phase: 'intermediate',
            ...normalized,
            newSessionId,
          });
        }
        pendingProgressText = textResult;
        log(
          `Intermediate assistant text buffered (${textResult.length} chars, stop=${stopReason})`,
        );
      }
    }
  }

  // Flush any remaining buffered text that was never followed by a result event.
  // This happens when the agent produces a short response without a formal end_turn.
  if (pendingProgressText && !terminalResultObserved) {
    log(
      `Flushing remaining pending progress text as final output (${pendingProgressText.length} chars)`,
    );
    writeOutput({
      status: 'success',
      ...normalizeStructuredOutput(pendingProgressText),
      newSessionId,
    });
    terminalResultObserved = true;
    resultCount++;
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, closedDuringQuery, terminalResultObserved };
}

async function main(): Promise<void> {
  let runnerInput: RunnerInput;

  try {
    const stdinData = await readStdin();
    runnerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${runnerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(runnerInput.secrets || {})) {
    sdkEnv[key] = value;
  }
  const reviewerRuntime =
    isReviewerRuntimeEnvEnabled(process.env) ||
    isReviewerRuntime(runnerInput.roomRoleContext);
  const claudeReadonlyReviewerRuntime = isClaudeReadonlyReviewerRuntime(
    runnerInput.roomRoleContext,
  );
  const claudeReadonlySandboxMode = claudeReadonlyReviewerRuntime
    ? getClaudeReadonlySandboxMode()
    : null;
  const readonlyRuntime =
    reviewerRuntime ||
    claudeReadonlyReviewerRuntime ||
    isArbiterRuntimeEnvEnabled(process.env);
  const guardedSdkEnv = buildReviewerGitGuardEnv(
    sdkEnv,
    reviewerRuntime || claudeReadonlyReviewerRuntime,
  );
  assertReadonlyWorkspaceRepoConnectivity(guardedSdkEnv, readonlyRuntime);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = runnerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous runner sessions
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Effective working directory (WORK_DIR overrides GROUP_DIR)
  const mainEffectiveCwd = WORK_DIR || GROUP_DIR;

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = runnerInput.prompt;
  if (runnerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput(IPC_INPUT_DIR, log);
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }
  // --- Slash command handling ---
  // Check BEFORE prepending room role header so /compact isn't masked.
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const isSessionSlashCommand = KNOWN_SESSION_COMMANDS.has(
    runnerInput.prompt.trim(),
  );

  if (!isSessionSlashCommand) {
    prompt = prependRoomRoleHeader(prompt, runnerInput.roomRoleContext);
  }
  const trimmedPrompt = prompt.trim();

  if (isSessionSlashCommand) {
    log(`Handling session command: ${trimmedPrompt}`);
    let slashSessionId: string | undefined;
    let compactBoundarySeen = false;
    let hadError = false;
    let resultEmitted = false;

    try {
      for await (const message of query({
        prompt: trimmedPrompt,
        options: {
          // 번들 CLI binary를 명시해야 SDK가 musl/glibc 잘못 탐색하는 걸 우회함.
          pathToClaudeCodeExecutable: getClaudeCliPath(),
          cwd: mainEffectiveCwd,
          resume: sessionId,
          systemPrompt: undefined,
          allowedTools: [],
          env: guardedSdkEnv,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'] as const,
          abortController: agentAbortController,
          hooks: {
            PreCompact: [
              {
                hooks: [
                  createPreCompactHook({
                    assistantName: runnerInput.assistantName,
                    groupDir: GROUP_DIR,
                    groupFolder: GROUP_FOLDER,
                    hostTasksDir: HOST_TASKS_DIR,
                    log,
                    writeOutput,
                  }),
                ],
              },
            ],
          },
        },
      })) {
        const msgType =
          message.type === 'system'
            ? `system/${(message as { subtype?: string }).subtype}`
            : message.type;
        log(`[slash-cmd] type=${msgType}`);

        if (message.type === 'system' && message.subtype === 'init') {
          slashSessionId = message.session_id;
          log(`Session after slash command: ${slashSessionId}`);
        }

        // Observe compact_boundary to confirm compaction completed
        if (
          message.type === 'system' &&
          (message as { subtype?: string }).subtype === 'compact_boundary'
        ) {
          compactBoundarySeen = true;
          const meta = (
            message as {
              compact_metadata?: { trigger?: string; pre_tokens?: number };
            }
          ).compact_metadata;
          log(
            `Compact boundary — trigger=${meta?.trigger || '?'} pre_tokens=${meta?.pre_tokens ?? '?'}`,
          );
        }

        if (message.type === 'result') {
          const resultSubtype = (message as { subtype?: string }).subtype;
          const textResult =
            'result' in message
              ? (message as { result?: string }).result
              : null;

          if (resultSubtype?.startsWith('error')) {
            hadError = true;
            writeOutput({
              status: 'error',
              result: null,
              error: textResult || 'Session command failed.',
              newSessionId: slashSessionId,
            });
          } else {
            writeOutput({
              status: 'success',
              result: textResult || 'Conversation compacted.',
              newSessionId: slashSessionId,
            });
          }
          resultEmitted = true;
        }
      }
    } catch (err) {
      hadError = true;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Slash command error: ${errorMsg}`);
      writeOutput({ status: 'error', result: null, error: errorMsg });
    }

    log(
      `Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`,
    );

    // Warn if compact_boundary was never observed — compaction may not have occurred
    if (!hadError && !compactBoundarySeen) {
      log(
        'WARNING: compact_boundary was not observed. Compaction may not have completed.',
      );
    }

    // Only emit final session marker if no result was emitted yet and no error occurred
    if (!resultEmitted && !hadError) {
      writeOutput({
        status: 'success',
        result: compactBoundarySeen
          ? 'Conversation compacted.'
          : 'Compaction requested but compact_boundary was not observed.',
        newSessionId: slashSessionId,
      });
    } else if (!hadError) {
      // Emit session-only marker so host updates session tracking
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: slashSessionId,
      });
    }
    return;
  }
  // --- End slash command handling ---

  try {
    log(`Starting query (session: ${sessionId || 'new'})...`);

    const queryResult = await runQuery(
      prompt,
      sessionId,
      mcpServerPath,
      runnerInput,
      guardedSdkEnv,
      reviewerRuntime,
      claudeReadonlyReviewerRuntime,
      claudeReadonlySandboxMode,
    );
    if (queryResult.newSessionId) {
      sessionId = queryResult.newSessionId;
    }

    if (!queryResult.closedDuringQuery && !queryResult.terminalResultObserved) {
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });
    } else if (queryResult.terminalResultObserved) {
      log('Terminal result already emitted, exiting single-turn runtime');
    } else {
      log('Close sentinel consumed during query, exiting');
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    const errorCause =
      err instanceof Error && err.cause ? String(err.cause) : undefined;
    log(`Agent error: ${errorMessage}`);
    if (errorStack) log(`Stack: ${errorStack}`);
    if (errorCause) log(`Cause: ${errorCause}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
