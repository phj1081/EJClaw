import fs from 'fs';
import path from 'path';

import {
  HookCallback,
  PreCompactHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import { selectCompactMemoriesFromSummary } from './memory-selection.js';
import type { RunnerOutput } from './output-protocol.js';
import { isReviewerMutatingShellCommand } from './reviewer-runtime.js';

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface PreCompactHookOptions {
  assistantName?: string;
  groupDir: string;
  groupFolder: string;
  hostTasksDir: string;
  log: (message: string) => void;
  writeOutput: (output: RunnerOutput) => void;
}

const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
  log: (message: string) => void,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find(
      (current) => current.sessionId === sessionId,
    );
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

function trimSummary(summary: string, maxChars: number): string {
  if (summary.length <= maxChars) return summary;
  return summary.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

function writeHostTaskIpcFile(hostTasksDir: string, data: object): string {
  fs.mkdirSync(hostTasksDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(hostTasksDir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

async function persistCompactMemory(
  summary: string,
  sessionId: string,
  options: Pick<PreCompactHookOptions, 'groupFolder' | 'hostTasksDir' | 'log'>,
): Promise<void> {
  const normalized = summary.trim();
  if (!normalized || !options.groupFolder) return;

  try {
    const scopeKey = `room:${options.groupFolder}`;
    const selected = selectCompactMemoriesFromSummary(normalized, scopeKey);
    if (selected.length === 0) {
      options.log(
        'Skipped compact memory persist - no salient room memory found',
      );
      return;
    }

    for (const memory of selected) {
      const file = writeHostTaskIpcFile(options.hostTasksDir, {
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
      options.log(`Persisted compact memory via IPC (${file})`);
    }
  } catch (err) {
    options.log(
      `Failed to persist compact memory via IPC: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((current: { text?: string }) => current.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((current: { type: string }) => current.type === 'text')
          .map((current: { text: string }) => current.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Ignore malformed transcript rows and keep best-effort archive behavior.
    }
  }
  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  summary: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (date: Date) =>
    date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${summary || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const message of messages) {
    const sender =
      message.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      message.content.length > 2000
        ? message.content.slice(0, 2000) + '...'
        : message.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function createPreCompactHook(
  options: PreCompactHookOptions,
): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;
    const trigger = preCompact.trigger || 'auto';

    options.writeOutput({
      status: 'success',
      phase: 'progress',
      result: trigger === 'auto' ? '대화 요약 중...' : '컴팩트 중...',
    });

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      options.log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        options.log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath, options.log);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(options.groupDir, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        options.assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      options.log(`Archived conversation to ${filePath}`);

      if (summary) {
        await persistCompactMemory(summary, sessionId, options);
      }
    } catch (err) {
      options.log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

export function createSanitizeBashHook(): HookCallback {
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

export function createReviewerBashGuardHook(): HookCallback {
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
