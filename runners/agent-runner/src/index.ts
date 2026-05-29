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
import {
  EJCLAW_ENV,
  IPC_CLOSE_SENTINEL,
  IPC_INPUT_SUBDIR,
} from 'ejclaw-runners-shared';
import { fileURLToPath } from 'url';

import { prependRoomRoleHeader } from './room-role-context.js';
import {
  assertReadonlyWorkspaceRepoConnectivity,
  buildReviewerGitGuardEnv,
  getClaudeReadonlySandboxMode,
  isArbiterRuntimeEnvEnabled,
  isClaudeReadonlyReviewerRuntime,
  isReviewerRuntime,
  isReviewerRuntimeEnvEnabled,
} from './reviewer-runtime.js';
import { drainIpcInput } from './ipc-input.js';
import {
  buildCompactionOutput,
  readStdin,
  writeOutput,
} from './output-protocol.js';
import { buildClaudeSdkEnv } from './sdk-env.js';
import { runSessionCommand } from './session-command.js';
import { runClaudeQuery } from './claude-query-runner.js';
import type { RunnerInput } from './runner-input.js';

// Paths configurable via env vars.
const GROUP_DIR = process.env[EJCLAW_ENV.groupDir] || '/workspace/group';
const IPC_DIR = process.env[EJCLAW_ENV.ipcDir] || '/workspace/ipc';
const HOST_IPC_DIR = process.env[EJCLAW_ENV.hostIpcDir] || IPC_DIR;
// Optional: override cwd (agent works in this directory instead of GROUP_DIR)
const WORK_DIR = process.env[EJCLAW_ENV.workDir] || '';
const GROUP_FOLDER = process.env[EJCLAW_ENV.groupFolder] || '';

const IPC_INPUT_DIR = path.join(IPC_DIR, IPC_INPUT_SUBDIR);
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, IPC_CLOSE_SENTINEL);
const HOST_TASKS_DIR = path.join(HOST_IPC_DIR, 'tasks');

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// Graceful shutdown: SIGTERM → abort SDK query, allowing cleanup
const agentAbortController = new AbortController();
process.on('SIGTERM', () => {
  log('Received SIGTERM, aborting agent query...');
  agentAbortController.abort();
});

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
  const sdkEnv = buildClaudeSdkEnv(process.env, runnerInput.secrets || {});
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
    await runSessionCommand({
      prompt: trimmedPrompt,
      sessionId,
      cwd: mainEffectiveCwd,
      sdkEnv: guardedSdkEnv,
      abortController: agentAbortController,
      assistantName: runnerInput.assistantName,
      groupDir: GROUP_DIR,
      groupFolder: GROUP_FOLDER,
      hostTasksDir: HOST_TASKS_DIR,
      log,
    });
    return;
  }
  // --- End slash command handling ---

  try {
    log(`Starting query (session: ${sessionId || 'new'})...`);

    const queryResult = await runClaudeQuery({
      prompt,
      sessionId,
      mcpServerPath,
      runnerInput,
      sdkEnv: guardedSdkEnv,
      reviewerRuntime,
      claudeReadonlyReviewerRuntime,
      claudeReadonlySandboxMode,
      abortController: agentAbortController,
      paths: {
        groupDir: GROUP_DIR,
        groupFolder: GROUP_FOLDER,
        hostTasksDir: HOST_TASKS_DIR,
        ipcInputCloseSentinel: IPC_INPUT_CLOSE_SENTINEL,
        ipcInputDir: IPC_INPUT_DIR,
        workDir: WORK_DIR,
      },
      log,
    });
    if (queryResult.newSessionId) {
      sessionId = queryResult.newSessionId;
    }

    if (!queryResult.closedDuringQuery && !queryResult.terminalResultObserved) {
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
        ...buildCompactionOutput(queryResult.compaction),
      });
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
