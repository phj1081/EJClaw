/**
 * Stdio MCP Server for EJClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import {
  buildCiWatchPrompt,
  DEFAULT_WATCH_CI_CONTEXT_MODE,
  normalizeWatchCiIntervalSeconds,
} from './watch-ci.js';
import {
  formatHostEvidenceResponse,
  HOST_EVIDENCE_ACTIONS,
  normalizeHostEvidenceTailLines,
  resolveHostEvidenceResponsesDir,
  waitForHostEvidenceResponse,
} from './host-evidence.js';
import {
  computeVerificationSnapshotId,
  formatVerificationResponse,
  runVerificationRequestDirect,
  VERIFICATION_PROFILES,
} from './verification.js';
import { resolveIpcDirectories } from './ipc-paths.js';
import { buildSendMessageIpcPayload } from './ipc-message.js';

const { ipcDir: IPC_DIR, hostIpcDir: HOST_IPC_DIR } = resolveIpcDirectories(
  process.env,
);
const MESSAGES_DIR = path.join(HOST_IPC_DIR, 'messages');
const TASKS_DIR = path.join(HOST_IPC_DIR, 'tasks');
const HOST_EVIDENCE_RESPONSES_DIR =
  resolveHostEvidenceResponsesDir(HOST_IPC_DIR);
const REPO_ROOT = process.env.EJCLAW_WORK_DIR || process.cwd();

// Context from environment variables (set by the agent runner)
const chatJid = process.env.EJCLAW_CHAT_JID!;
const groupFolder = process.env.EJCLAW_GROUP_FOLDER!;
const isMain = process.env.EJCLAW_IS_MAIN === '1';
const agentType = process.env.EJCLAW_AGENT_TYPE || 'claude-code';
const runtimeTaskId = process.env.EJCLAW_RUNTIME_TASK_ID;
const allowGenericScheduling = agentType !== 'codex';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'ejclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data = buildSendMessageIpcPayload({
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      senderRole: process.env.EJCLAW_ROOM_ROLE || undefined,
      runId: process.env.EJCLAW_RUN_ID || undefined,
      groupFolder,
    });

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

if (allowGenericScheduling) {
  server.tool(
    'schedule_task',
    `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
    {
      prompt: z
        .string()
        .describe(
          'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
        ),
      schedule_type: z
        .enum(['cron', 'interval', 'once'])
        .describe(
          'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
        ),
      schedule_value: z
        .string()
        .describe(
          'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
        ),
      context_mode: z
        .enum(['group', 'isolated'])
        .default('group')
        .describe(
          'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
        ),
      target_group_jid: z
        .string()
        .optional()
        .describe(
          '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
        ),
    },
    async (args) => {
      // Validate schedule_value before writing IPC
      if (args.schedule_type === 'cron') {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
              },
            ],
            isError: true,
          };
        }
      } else if (args.schedule_type === 'interval') {
        const ms = parseInt(args.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
              },
            ],
            isError: true,
          };
        }
      } else if (args.schedule_type === 'once') {
        if (
          /[Zz]$/.test(args.schedule_value) ||
          /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
        ) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
              },
            ],
            isError: true,
          };
        }
        const date = new Date(args.schedule_value);
        if (isNaN(date.getTime())) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
              },
            ],
            isError: true,
          };
        }
      }

      // Non-main groups can only schedule for themselves
      const targetJid =
        isMain && args.target_group_jid ? args.target_group_jid : chatJid;

      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const data = {
        type: 'schedule_task',
        taskId,
        prompt: args.prompt,
        schedule_type: args.schedule_type,
        schedule_value: args.schedule_value,
        context_mode: args.context_mode || 'group',
        targetJid,
        createdBy: groupFolder,
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(TASKS_DIR, data);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
          },
        ],
      };
    },
  );
}

server.tool(
  'watch_ci',
  'Schedule a background CI watcher that checks until a run or check reaches a terminal state, then sends one message and cancels itself. Use this for CI, benchmark, deploy, or profiling completion tracking instead of generic recurring scheduling.',
  {
    target: z
      .string()
      .optional()
      .describe(
        'What to watch, for example "PR #123 checks" or "GitHub Actions run 987654321".',
      ),
    check_instructions: z
      .string()
      .optional()
      .describe(
        'Exact steps or commands to check status and what details matter when it finishes.',
      ),
    ci_provider: z
      .enum(['github'])
      .optional()
      .describe(
        'Optional structured CI provider selector. When set to "github", the watcher can use a host-driven fast path.',
      ),
    ci_repo: z
      .string()
      .optional()
      .describe(
        'Optional GitHub repository in "owner/repo" format for host-driven GitHub watchers.',
      ),
    ci_run_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional GitHub Actions run ID for host-driven GitHub watchers.',
      ),
    ci_pr_number: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional PR number reserved for future GitHub PR-check watchers.',
      ),
    poll_interval_seconds: z
      .number()
      .int()
      .min(10)
      .max(3600)
      .optional()
      .describe(
        'How often to poll in seconds. Defaults to 60 for generic watchers and 15 for GitHub host-driven watchers. Generic watchers require 30+, GitHub host-driven watchers allow 10+.',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default(DEFAULT_WATCH_CI_CONTEXT_MODE)
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include all context in check_instructions). Default: isolated.',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the watcher for. Defaults to the current group.',
      ),
  },
  async (args) => {
    const isGitHubWatcher = args.ci_provider === 'github';
    const target =
      args.target ||
      (isGitHubWatcher && args.ci_run_id
        ? `GitHub Actions run ${args.ci_run_id}`
        : undefined);
    const checkInstructions =
      args.check_instructions ||
      (isGitHubWatcher
        ? 'This watcher is handled by the host-driven GitHub Actions path. Do not rely on the prompt for execution.'
        : undefined);

    if (!target) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'target is required unless structured GitHub watcher fields are provided.',
          },
        ],
        isError: true,
      };
    }

    if (!checkInstructions) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'check_instructions is required for generic CI watchers.',
          },
        ],
        isError: true,
      };
    }

    if (isGitHubWatcher && (!args.ci_repo || !args.ci_run_id)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'GitHub host-driven watchers require both ci_repo and ci_run_id.',
          },
        ],
        isError: true,
      };
    }

    let pollSeconds: number;
    try {
      pollSeconds = normalizeWatchCiIntervalSeconds(
        args.poll_interval_seconds,
        {
          ciProvider: args.ci_provider,
        },
      );
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }

    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const prompt = buildCiWatchPrompt({
      target,
      checkInstructions,
    });

    const data = {
      type: 'schedule_task',
      taskId,
      prompt,
      schedule_type: 'interval' as const,
      schedule_value: String(pollSeconds * 1000),
      context_mode: args.context_mode || DEFAULT_WATCH_CI_CONTEXT_MODE,
      ci_provider: args.ci_provider,
      ci_metadata: isGitHubWatcher
        ? JSON.stringify({
            repo: args.ci_repo,
            run_id: args.ci_run_id,
          })
        : undefined,
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `CI watcher scheduled for ${target} (${pollSeconds}s interval)`,
        },
      ],
    };
  },
);

server.tool(
  'read_host_evidence',
  'Read host-side deployment evidence through a narrow allowlist. Use this instead of broad shell access when reviewer/arbiter needs service status or recent logs.',
  {
    action: z
      .enum(HOST_EVIDENCE_ACTIONS)
      .describe(
        'ejclaw_service_status=systemctl --user show ejclaw, ejclaw_service_logs=recent journalctl lines',
      ),
    tail_lines: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Only for ejclaw_service_logs. Number of recent journal lines to fetch. Defaults to 20.',
      ),
  },
  async (args) => {
    const requestId = `host-evidence-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'host_evidence_request',
      requestId,
      action: args.action,
      tail_lines:
        args.action === 'ejclaw_service_logs'
          ? normalizeHostEvidenceTailLines(args.tail_lines)
          : undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    try {
      const response = await waitForHostEvidenceResponse(
        HOST_EVIDENCE_RESPONSES_DIR,
        requestId,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: formatHostEvidenceResponse(response),
          },
        ],
        isError: !response.ok,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'run_verification',
  'Run a fixed verification profile directly on the host against the current repo snapshot using a restricted environment and snapshot checks. Use this instead of broad shell write access for test/typecheck/build/lint verification.',
  {
    profile: z
      .enum(VERIFICATION_PROFILES)
      .describe(
        'Fixed verification profile. Runs the workspace test/typecheck/build/lint scripts with the repo-configured package manager.',
      ),
  },
  async (args) => {
    let snapshotId: string;
    try {
      snapshotId = computeVerificationSnapshotId(REPO_ROOT);
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }

    const requestId = `verification-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    try {
      const response = await runVerificationRequestDirect(REPO_ROOT, {
        requestId,
        profile: args.profile,
        expectedSnapshotId: snapshotId,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: formatVerificationResponse(response),
          },
        ],
        isError: !response.ok,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args: { task_id: string }) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args: { task_id: string }) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task. If no task_id is provided, cancels the current task (for background watchers).',
  {
    task_id: z
      .string()
      .optional()
      .describe('The task ID to cancel. Omit to cancel the current task.'),
  },
  async (args: { task_id?: string }) => {
    const resolvedId = args.task_id || runtimeTaskId;
    if (!resolvedId) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No task_id provided and no current task context available.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'cancel_task',
      taskId: resolvedId,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        { type: 'text' as const, text: `Task cancellation requested.` },
      ],
    };
  },
);

if (allowGenericScheduling) {
  server.tool(
    'update_task',
    'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
    {
      task_id: z.string().describe('The task ID to update'),
      prompt: z.string().optional().describe('New prompt for the task'),
      schedule_type: z
        .enum(['cron', 'interval', 'once'])
        .optional()
        .describe('New schedule type'),
      schedule_value: z
        .string()
        .optional()
        .describe('New schedule value (see schedule_task for format)'),
    },
    async (args: {
      task_id: string;
      prompt?: string;
      schedule_type?: 'cron' | 'interval' | 'once';
      schedule_value?: string;
    }) => {
      // Validate schedule_value if provided
      if (
        args.schedule_type === 'cron' ||
        (!args.schedule_type && args.schedule_value)
      ) {
        if (args.schedule_value) {
          try {
            CronExpressionParser.parse(args.schedule_value);
          } catch {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid cron: "${args.schedule_value}".`,
                },
              ],
              isError: true,
            };
          }
        }
      }
      if (args.schedule_type === 'interval' && args.schedule_value) {
        const ms = parseInt(args.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid interval: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }

      const data: Record<string, string | undefined> = {
        type: 'update_task',
        taskId: args.task_id,
        groupFolder,
        isMain: String(isMain),
        timestamp: new Date().toISOString(),
      };
      if (args.prompt !== undefined) data.prompt = args.prompt;
      if (args.schedule_type !== undefined)
        data.schedule_type = args.schedule_type;
      if (args.schedule_value !== undefined)
        data.schedule_value = args.schedule_value;

      writeIpcFile(TASKS_DIR, data);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Task ${args.task_id} update requested.`,
          },
        ],
      };
    },
  );
}

server.tool(
  'assign_room',
  `Assign or update a room using room-level settings. Main group only.

If folder is omitted, the host generates one automatically.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the room'),
    room_mode: z
      .enum(['single', 'tribunal'])
      .default('single')
      .describe('single=owner only, tribunal=owner/reviewer roles enabled'),
    owner_agent_type: z
      .enum(['claude-code', 'codex'])
      .optional()
      .describe('Preferred owner agent type for the room'),
    reviewer_agent_type: z
      .enum(['claude-code', 'codex'])
      .optional()
      .describe('Optional reviewer agent type override for tribunal rooms'),
    arbiter_agent_type: z
      .enum(['claude-code', 'codex'])
      .optional()
      .describe('Optional arbiter agent type override for tribunal rooms'),
    folder: z
      .string()
      .optional()
      .describe(
        'Optional folder override. If omitted, the host generates one automatically.',
      ),
    trigger: z
      .string()
      .optional()
      .describe('Optional canonical trigger label to store for the room'),
    requires_trigger: z
      .boolean()
      .optional()
      .describe('Whether direct trigger mention is required'),
    is_main: z
      .boolean()
      .optional()
      .describe('Whether this room is the privileged main control room'),
    work_dir: z
      .string()
      .optional()
      .describe('Optional working directory override'),
  },
  async (args: {
    jid: string;
    name: string;
    room_mode?: 'single' | 'tribunal';
    owner_agent_type?: 'claude-code' | 'codex';
    reviewer_agent_type?: 'claude-code' | 'codex';
    arbiter_agent_type?: 'claude-code' | 'codex';
    folder?: string;
    trigger?: string;
    requires_trigger?: boolean;
    is_main?: boolean;
    work_dir?: string;
  }) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can assign rooms.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'assign_room',
      jid: args.jid,
      name: args.name,
      room_mode: args.room_mode || 'single',
      owner_agent_type: args.owner_agent_type,
      reviewer_agent_type: args.reviewer_agent_type,
      arbiter_agent_type: args.arbiter_agent_type,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requires_trigger,
      isMain: args.is_main,
      workDir: args.work_dir,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Room "${args.name}" assignment requested.`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
