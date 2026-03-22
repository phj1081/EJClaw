/**
 * EJClaw Codex Runner
 *
 * App-server only runtime.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages as JSON files in $EJCLAW_IPC_DIR/input/
 *          Sentinel: _close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';

import {
  CodexAppServerClient,
  type AppServerInputItem,
} from './app-server-client.js';

// ── Types ──────────────────────────────────────────────────────────

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  agentType?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  phase?: 'progress' | 'final';
  newSessionId?: string;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────

const GROUP_DIR = process.env.EJCLAW_GROUP_DIR || '/workspace/group';
const IPC_DIR = process.env.EJCLAW_IPC_DIR || '/workspace/ipc';
const WORK_DIR = process.env.EJCLAW_WORK_DIR || '';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---EJCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---EJCLAW_OUTPUT_END---';

const EFFECTIVE_CWD = WORK_DIR || GROUP_DIR;
const CODEX_MODEL = process.env.CODEX_MODEL || '';
const CODEX_EFFORT = process.env.CODEX_EFFORT || '';

let closeRequested = false;

// ── Helpers ────────────────────────────────────────────────────────

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[codex-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function consumeCloseSentinel(): boolean {
  if (closeRequested) return true;
  if (!fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) return false;

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }
  closeRequested = true;
  return true;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function extractImagePaths(text: string): { cleanText: string; imagePaths: string[] } {
  const imagePattern = /\[Image:\s*(\/[^\]]+)\]/g;
  const imagePaths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = imagePattern.exec(text)) !== null) {
    imagePaths.push(match[1].trim());
  }

  return {
    cleanText: text.replace(imagePattern, '').trim(),
    imagePaths,
  };
}

function parseAppServerInput(text: string): AppServerInputItem[] {
  const { cleanText, imagePaths } = extractImagePaths(text);
  const input: AppServerInputItem[] = [];

  if (cleanText) {
    input.push({ type: 'text', text: cleanText });
  }

  for (const imgPath of imagePaths) {
    if (fs.existsSync(imgPath)) {
      input.push({ type: 'localImage', path: imgPath });
      log(`Adding image input: ${imgPath}`);
    } else {
      log(`Image not found, skipping: ${imgPath}`);
    }
  }

  if (input.length === 0) {
    input.push({ type: 'text', text });
  }

  return input;
}

function formatProgressElapsed(ms: number): string {
  const elapsedSeconds = Math.floor(ms / 10_000) * 10;
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}시간`);
  if (minutes > 0) parts.push(`${minutes}분`);
  parts.push(`${seconds}초`);

  return parts.join(' ');
}

async function executeAppServerTurn(
  client: CodexAppServerClient,
  threadId: string,
  prompt: string,
): Promise<{ result: string | null; error?: string }> {
  let lastProgressMessage: string | null = null;
  const activeTurn = await client.startTurn(threadId, parseAppServerInput(prompt), {
    cwd: EFFECTIVE_CWD,
    model: CODEX_MODEL || undefined,
    effort: CODEX_EFFORT || undefined,
    onProgress: (message) => {
      const trimmed = message.trim();
      if (!trimmed || trimmed === lastProgressMessage) {
        return;
      }
      lastProgressMessage = trimmed;
      writeOutput({
        status: 'success',
        phase: 'progress',
        result: trimmed,
        newSessionId: threadId,
      });
    },
  });

  let elapsedMs = 0;
  let polling = true;
  const pollDuringTurn = async () => {
    if (!polling) return;

    if (consumeCloseSentinel()) {
      log('Close sentinel detected during app-server turn, interrupting');
      polling = false;
      try {
        await activeTurn.interrupt();
      } catch (err) {
        log(
          `Failed to interrupt active turn: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    const messages = drainIpcInput();
    if (messages.length > 0) {
      const merged = messages.join('\n');
      log(`Steering active turn with ${messages.length} queued message(s)`);
      try {
        await activeTurn.steer(parseAppServerInput(merged));
      } catch (err) {
        log(
          `turn/steer failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    elapsedMs += IPC_POLL_MS;
    if (elapsedMs > 0 && elapsedMs % 60000 === 0) {
      log(`Turn in progress... (${formatProgressElapsed(elapsedMs)})`);
    }
    setTimeout(() => void pollDuringTurn(), IPC_POLL_MS);
  };

  setTimeout(() => void pollDuringTurn(), IPC_POLL_MS);

  try {
    const { state, result } = await activeTurn.wait();
    if (state.status === 'completed') {
      return { result };
    }
    if (state.status === 'interrupted' && consumeCloseSentinel()) {
      return { result };
    }
    return {
      result,
      error: state.errorMessage || `Codex turn finished with status ${state.status}`,
    };
  } finally {
    polling = false;
  }
}

async function runAppServerCompact(
  client: CodexAppServerClient,
  threadId: string | undefined,
): Promise<void> {
  if (!threadId) {
    writeOutput({
      status: 'success',
      result: '현재 활성 Codex 세션이 없어 compact를 건너뜁니다.',
    });
    return;
  }

  const { state } = await client.startCompaction(threadId);
  if (state.status === 'failed') {
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: threadId,
      error: state.errorMessage || 'Conversation compaction failed.',
    });
    return;
  }

  writeOutput({
    status: 'success',
    result: state.compactionCompleted
      ? 'Conversation compacted.'
      : 'Compaction requested but contextCompaction was not observed.',
    newSessionId: threadId,
  });
}

async function runAppServerSession(
  containerInput: ContainerInput,
  prompt: string,
): Promise<void> {
  const client = new CodexAppServerClient({
    cwd: EFFECTIVE_CWD,
    env: process.env,
    log,
  });

  await client.start();

  let threadId: string | undefined;
  try {
    try {
      threadId = await client.startOrResumeThread(containerInput.sessionId, {
        cwd: EFFECTIVE_CWD,
        model: CODEX_MODEL || undefined,
      });
      log(
        containerInput.sessionId
          ? `App-server thread resumed (${threadId})`
          : `App-server thread started (${threadId})`,
      );
    } catch (err) {
      if (!containerInput.sessionId) throw err;
      log(
        `App-server resume failed, retrying with new thread: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      threadId = await client.startOrResumeThread(undefined, {
        cwd: EFFECTIVE_CWD,
        model: CODEX_MODEL || undefined,
      });
      log(`App-server thread restarted (${threadId})`);
    }

    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt === '/compact') {
      await runAppServerCompact(client, threadId);
      return;
    }

    log('Starting app-server turn...');
    const { result, error } = await executeAppServerTurn(client, threadId, prompt);

    if (error) {
      log(`App-server turn error: ${error}`);
      writeOutput({
        status: 'error',
        result: result || null,
        newSessionId: threadId,
        error,
      });
    } else {
      writeOutput({
        status: 'success',
        result: result || null,
        ...(result ? { phase: 'final' as const } : {}),
        newSessionId: threadId,
      });
    }

    if (consumeCloseSentinel()) {
      log('Close sentinel detected, exiting app-server runtime');
    }
  } finally {
    await client.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    process.exit(1);
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  closeRequested = false;
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  try {
    log('Runtime selected: app-server');
    await runAppServerSession(containerInput, prompt);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Runner error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
  }
}

main();
