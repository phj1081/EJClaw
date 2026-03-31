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
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

import {
  prependRoomRoleHeader,
  type RoomRoleContext,
} from './room-role-context.js';
import {
  buildReviewerGitGuardEnv,
  isReviewerMutatingShellCommand,
  isReviewerRuntime,
} from './reviewer-runtime.js';
import { selectCompactMemoriesFromSummary } from './memory-selection.js';

interface ContainerInput {
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

/** Mirrors AgentOutput in src/agent-runner.ts (separate package, can't import directly). */
interface ContainerOutput {
  status: 'success' | 'error';
  phase?: 'progress' | 'final' | 'tool-activity' | 'intermediate';
  agentId?: string;
  agentLabel?: string;
  agentDone?: boolean;
  result: string | null;
  output?: {
    visibility: 'public' | 'silent';
    text?: string;
    verdict?: 'done' | 'done_with_concerns' | 'blocked' | 'silent';
  };
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } };

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

interface AssistantContentBlock {
  type?: string;
  text?: string;
}

// Paths configurable via env vars.
const GROUP_DIR = process.env.EJCLAW_GROUP_DIR || '/workspace/group';
const IPC_DIR = process.env.EJCLAW_IPC_DIR || '/workspace/ipc';
const HOST_IPC_DIR = process.env.EJCLAW_HOST_IPC_DIR || IPC_DIR;
// Optional: override cwd (agent works in this directory instead of GROUP_DIR)
const WORK_DIR = process.env.EJCLAW_WORK_DIR || '';
const GROUP_FOLDER = process.env.EJCLAW_GROUP_FOLDER || '';

const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const HOST_TASKS_DIR = path.join(HOST_IPC_DIR, 'tasks');

/** SSOT: src/agent-protocol.ts — keep in sync */
const IMAGE_TAG_RE = /\[Image:\s*(\/[^\]]+)\]/g;
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
};

/**
 * Parse [Image: /absolute/path] tags from text and build multimodal content.
 * Returns a plain string if no images found, or ContentBlock[] with text + image blocks.
 */
function buildMultimodalContent(text: string): string | ContentBlock[] {
  const imagePaths: string[] = [];
  let match;
  while ((match = IMAGE_TAG_RE.exec(text)) !== null) {
    imagePaths.push(match[1].trim());
  }
  IMAGE_TAG_RE.lastIndex = 0; // reset regex state

  if (imagePaths.length === 0) return text;

  const blocks: ContentBlock[] = [];
  const cleanText = text.replace(IMAGE_TAG_RE, '').trim();
  if (cleanText) {
    blocks.push({ type: 'text', text: cleanText });
  }

  for (const imgPath of imagePaths) {
    try {
      if (!fs.existsSync(imgPath)) {
        log(`Image not found, skipping: ${imgPath}`);
        continue;
      }
      const data = fs.readFileSync(imgPath).toString('base64');
      const ext = path.extname(imgPath).toLowerCase();
      const mediaType = (MIME_TYPES[ext] || 'image/png') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
      log(`Added image block: ${imgPath} (${mediaType})`);
    } catch (err) {
      log(`Failed to read image ${imgPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return blocks.length > 0 ? blocks : text;
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    const content = buildMultimodalContent(text);
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---EJCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---EJCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function normalizeStructuredOutput(result: string | null): {
  result: string | null;
  output?: ContainerOutput['output'];
} {
  if (typeof result !== 'string' || result.length === 0) {
    return { result };
  }
  // All output is public — silent suppression was removed.
  return { result, output: { visibility: 'public', text: result } };
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// Graceful shutdown: SIGTERM → abort SDK query, allowing cleanup
const agentAbortController = new AbortController();
process.on('SIGTERM', () => {
  log('Received SIGTERM, aborting agent query...');
  agentAbortController.abort();
});

function extractAssistantText(message: unknown): string | null {
  const assistant = message as {
    message?: {
      content?: AssistantContentBlock[];
    };
  };
  const blocks = assistant.message?.content;
  if (!Array.isArray(blocks)) return null;

  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();

  return text || null;
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

function trimSummary(summary: string, maxChars: number): string {
  if (summary.length <= maxChars) return summary;
  return summary.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

function writeHostTaskIpcFile(data: object): string {
  fs.mkdirSync(HOST_TASKS_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(HOST_TASKS_DIR, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

async function persistCompactMemory(summary: string, sessionId: string): Promise<void> {
  const normalized = summary.trim();
  if (!normalized || !GROUP_FOLDER) return;

  try {
    const scopeKey = `room:${GROUP_FOLDER}`;
    const selected = selectCompactMemoriesFromSummary(normalized, scopeKey);
    if (selected.length === 0) {
      log('Skipped compact memory persist - no salient room memory found');
      return;
    }

    for (const memory of selected) {
      const file = writeHostTaskIpcFile({
        type: 'persist_memory',
        scopeKind: 'room',
        scopeKey,
        content: trimSummary(memory.content, 300),
        keywords: memory.keywords,
        memory_kind: memory.memoryKind,
        source_kind: 'compact',
        source_ref: sessionId ? `compact:${sessionId}` : null,
        timestamp: new Date().toISOString(),
      });
      log(`Persisted compact memory via IPC (${file})`);
    }
  } catch (err) {
    log(
      `Failed to persist compact memory via IPC: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;
    const trigger = preCompact.trigger || 'auto';

    // Show compact status in chat so users know it's not just slow loading
    writeOutput({
      status: 'success',
      phase: 'progress',
      result: trigger === 'auto' ? '대화 요약 중...' : '컴팩트 중...',
    });

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(GROUP_DIR, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);

      if (summary) {
        await persistCompactMemory(summary, sessionId);
      }
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function createReviewerBashGuardHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command || !isReviewerMutatingShellCommand(command)) {
      return {};
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'EJClaw reviewer runtime blocks mutating shell commands in paired review mode.',
      },
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
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
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

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
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  reviewerRuntime: boolean,
): Promise<{
  newSessionId?: string;
  closedDuringQuery: boolean;
  terminalResultObserved: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      // Flush any buffered text before closing — the for-await loop may not
      // reach the post-loop flush code after stream.end().
      if (pendingProgressText && !terminalResultObserved) {
        log(`Flushing pending text before close (${pendingProgressText.length} chars)`);
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
    const messages = drainIpcInput();
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

  // Discover additional directories
  const extraDirs: string[] = [];

  // When WORK_DIR is set, use it as cwd and include GROUP_DIR as additional directory
  const effectiveCwd = WORK_DIR || GROUP_DIR;
  if (WORK_DIR && WORK_DIR !== GROUP_DIR) {
    extraDirs.push(GROUP_DIR);
    log(`Work directory override: ${WORK_DIR} (group dir added to additionalDirectories)`);
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
  const effort = (process.env.CLAUDE_EFFORT as 'low' | 'medium' | 'high' | 'max') || undefined;
  const thinking = thinkingType === 'adaptive' ? { type: 'adaptive' as const }
    : thinkingType === 'enabled' ? { type: 'enabled' as const, budgetTokens: thinkingBudget }
    : thinkingType === 'disabled' ? { type: 'disabled' as const }
    : undefined;

  if (model) log(`Using model: ${model}`);
  if (thinking) log(`Thinking config: ${JSON.stringify(thinking)}`);
  if (effort) log(`Effort: ${effort}`);
  if (reviewerRuntime) log('Reviewer runtime restrictions enabled');

  const allowedTools = reviewerRuntime
    ? [
        'Bash',
        'Read', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'mcp__ejclaw__*',
      ]
    : [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__ejclaw__*'
      ];

  for await (const message of query({
    prompt: stream,
    options: {
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
      settingSources: ['project', 'user'],
      abortController: agentAbortController,
      mcpServers: {
        ejclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            EJCLAW_CHAT_JID: containerInput.chatJid,
            EJCLAW_GROUP_FOLDER: containerInput.groupFolder,
            EJCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            EJCLAW_AGENT_TYPE:
              process.env.EJCLAW_AGENT_TYPE || 'claude-code',
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
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: reviewerRuntime
              ? [createReviewerBashGuardHook(), createSanitizeBashHook()]
              : [createSanitizeBashHook()],
          },
        ],
      },
      agentProgressSummaries: true,
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    // Flush pending intermediate text as a regular message on non-assistant events.
    if (message.type !== 'assistant' && pendingProgressText) {
      writeOutput({
        status: 'success',
        phase: 'intermediate',
        result: pendingProgressText,
        newSessionId,
      });
      pendingProgressText = null;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
      const meta = (message as { compact_metadata?: { trigger?: string; pre_tokens?: number } }).compact_metadata;
      log(`Compact boundary — trigger=${meta?.trigger || '?'} pre_tokens=${meta?.pre_tokens ?? '?'}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
      if (tn.status === 'completed' || tn.status === 'error' || tn.status === 'cancelled') {
        writeOutput({
          status: 'success',
          phase: 'progress',
          agentId: tn.task_id,
          agentDone: true,
          result: tn.summary || null,
          newSessionId,
        });
      }
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_progress') {
      const tp = message as Record<string, unknown>;
      const taskId = typeof tp.task_id === 'string' ? tp.task_id : undefined;
      const summary = typeof tp.summary === 'string' ? tp.summary : '';
      const description = typeof tp.description === 'string' ? tp.description : '';
      if (description && description.length <= 80) {
        // Short tool description → show as sub-line in progress
        const normalized = normalizeStructuredOutput(description);
        writeOutput({
          status: 'success',
          phase: 'tool-activity',
          ...normalized,
          agentId: taskId,
          newSessionId,
        });
      } else if (description) {
        // Long AI summary → skip (too long for progress sub-line)
        log(`Skipping long task_progress description (${description.length} chars)`);
      }
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_started') {
      const ts = message as { task_id: string; description?: string };
      const desc = ts.description || '';
      log(`Subagent started: task=${ts.task_id} desc=${desc.slice(0, 200)}`);
      if (desc) {
        const normalized = normalizeStructuredOutput(`🔄 ${desc}`);
        writeOutput({
          status: 'success',
          phase: 'progress',
          ...normalized,
          agentId: ts.task_id,
          agentLabel: desc,
          newSessionId,
        });
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
      let textResult = 'result' in message ? (message as { result?: string }).result : null;
      const isError = message.subtype?.startsWith('error');
      // Discard pending progress if it matches the final result (prevent duplicate)
      if (pendingProgressText && textResult && pendingProgressText === textResult) {
        log(`Discarding pending progress (matches result)`);
        pendingProgressText = null;
      } else if (pendingProgressText) {
        // If the result has no text, promote pending progress to the result
        // so it gets delivered as the final output instead of being lost.
        if (!textResult) {
          log(`Promoting pending progress text to result (${pendingProgressText.length} chars)`);
          textResult = pendingProgressText;
        } else {
          writeOutput({ status: 'success', phase: 'intermediate', result: pendingProgressText, newSessionId });
        }
        pendingProgressText = null;
      }
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      if (isError) {
        // Log full error details for debugging
        const msg = message as Record<string, unknown>;
        const sdkErrors = Array.isArray(msg.errors) ? msg.errors as string[] : [];
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
        const errorText = sdkErrors.length > 0 ? sdkErrors.join('; ') : undefined;
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
          newSessionId
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
      const stopReason = (message as { stop_reason?: string }).stop_reason;
      const textResult = extractAssistantText(message);
      // Only log when there's something interesting (text or terminal)
      if (textResult || stopReason === 'end_turn') {
        log(`Assistant: stop=${stopReason} text=${textResult ? textResult.length + ' chars' : 'null'}`);
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
        log(`Intermediate assistant text buffered (${textResult.length} chars, stop=${stopReason})`);
      }
    }
  }

  // Flush any remaining buffered text that was never followed by a result event.
  // This happens when the agent produces a short response without a formal end_turn.
  if (pendingProgressText && !terminalResultObserved) {
    log(`Flushing remaining pending progress text as final output (${pendingProgressText.length} chars)`);
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
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }
  const reviewerRuntime =
    process.env.EJCLAW_REVIEWER_RUNTIME === '1' ||
    isReviewerRuntime(containerInput.roomRoleContext);
  const guardedSdkEnv = buildReviewerGitGuardEnv(sdkEnv, reviewerRuntime);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Effective working directory (WORK_DIR overrides GROUP_DIR)
  const mainEffectiveCwd = WORK_DIR || GROUP_DIR;

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }
  // --- Slash command handling ---
  // Check BEFORE prepending room role header so /compact isn't masked.
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const isSessionSlashCommand = KNOWN_SESSION_COMMANDS.has(containerInput.prompt.trim());

  if (!isSessionSlashCommand) {
    prompt = prependRoomRoleHeader(prompt, containerInput.roomRoleContext);
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
            PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
          },
        },
      })) {
        const msgType = message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
        log(`[slash-cmd] type=${msgType}`);

        if (message.type === 'system' && message.subtype === 'init') {
          slashSessionId = message.session_id;
          log(`Session after slash command: ${slashSessionId}`);
        }

        // Observe compact_boundary to confirm compaction completed
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          compactBoundarySeen = true;
          const meta = (message as { compact_metadata?: { trigger?: string; pre_tokens?: number } }).compact_metadata;
          log(`Compact boundary — trigger=${meta?.trigger || '?'} pre_tokens=${meta?.pre_tokens ?? '?'}`);
        }

        if (message.type === 'result') {
          const resultSubtype = (message as { subtype?: string }).subtype;
          const textResult = 'result' in message ? (message as { result?: string }).result : null;

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

    log(`Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`);

    // Warn if compact_boundary was never observed — compaction may not have occurred
    if (!hadError && !compactBoundarySeen) {
      log('WARNING: compact_boundary was not observed. Compaction may not have completed.');
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
      writeOutput({ status: 'success', result: null, newSessionId: slashSessionId });
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
      containerInput,
      guardedSdkEnv,
      reviewerRuntime,
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
    const errorCause = err instanceof Error && err.cause ? String(err.cause) : undefined;
    log(`Agent error: ${errorMessage}`);
    if (errorStack) log(`Stack: ${errorStack}`);
    if (errorCause) log(`Cause: ${errorCause}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
