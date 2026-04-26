import { isWatchCiTask } from './task-watch-status.js';
import type { StatusSnapshot, UsageRowSnapshot } from './status-dashboard.js';
import type { ScheduledTask } from './types.js';

export interface SanitizedScheduledTask {
  id: string;
  groupFolder: string;
  chatJid: string;
  agentType: ScheduledTask['agent_type'];
  ciProvider: ScheduledTask['ci_provider'];
  ciMetadata: ScheduledTask['ci_metadata'];
  scheduleType: ScheduledTask['schedule_type'];
  scheduleValue: string;
  contextMode: ScheduledTask['context_mode'];
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  status: ScheduledTask['status'];
  suspendedUntil: string | null;
  createdAt: string;
  promptPreview: string;
  promptLength: number;
  isWatcher: boolean;
}

export interface WebDashboardOverview {
  generatedAt: string;
  services: Array<{
    serviceId: string;
    assistantName: string;
    agentType: StatusSnapshot['agentType'];
    updatedAt: string;
    totalRooms: number;
    activeRooms: number;
  }>;
  rooms: {
    total: number;
    active: number;
    waiting: number;
    inactive: number;
  };
  tasks: {
    total: number;
    active: number;
    paused: number;
    completed: number;
    watchers: {
      active: number;
      paused: number;
      completed: number;
    };
  };
  usage: {
    rows: UsageRowSnapshot[];
    fetchedAt: string | null;
  };
}

const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*([^\s"'`]+)/gi;
const SECRET_VALUE_RE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})\b/g;

function redactSensitiveText(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT_RE, '$1=<redacted>')
    .replace(SECRET_VALUE_RE, '<redacted-token>');
}

function truncateText(value: string, maxLength = 120): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function buildPromptPreview(prompt: string): string {
  return truncateText(redactSensitiveText(prompt).replace(/\s+/g, ' ').trim());
}

export function sanitizeScheduledTask(
  task: ScheduledTask,
): SanitizedScheduledTask {
  return {
    id: task.id,
    groupFolder: task.group_folder,
    chatJid: task.chat_jid,
    agentType: task.agent_type,
    ciProvider: task.ci_provider ?? null,
    ciMetadata: task.ci_metadata ?? null,
    scheduleType: task.schedule_type,
    scheduleValue: task.schedule_value,
    contextMode: task.context_mode,
    nextRun: task.next_run,
    lastRun: task.last_run,
    lastResult: task.last_result,
    status: task.status,
    suspendedUntil: task.suspended_until ?? null,
    createdAt: task.created_at,
    promptPreview: buildPromptPreview(task.prompt),
    promptLength: task.prompt.length,
    isWatcher: isWatchCiTask(task),
  };
}

export function buildWebDashboardOverview(args: {
  now?: string;
  snapshots: StatusSnapshot[];
  tasks: ScheduledTask[];
}): WebDashboardOverview {
  const rooms = {
    total: 0,
    active: 0,
    waiting: 0,
    inactive: 0,
  };

  const services = args.snapshots.map((snapshot) => {
    let activeRooms = 0;
    for (const entry of snapshot.entries) {
      rooms.total += 1;
      if (entry.status === 'processing') {
        rooms.active += 1;
        activeRooms += 1;
      } else if (entry.status === 'waiting') {
        rooms.waiting += 1;
        activeRooms += 1;
      } else {
        rooms.inactive += 1;
      }
    }

    return {
      serviceId: snapshot.serviceId,
      assistantName: snapshot.assistantName,
      agentType: snapshot.agentType,
      updatedAt: snapshot.updatedAt,
      totalRooms: snapshot.entries.length,
      activeRooms,
    };
  });

  const tasks = {
    total: args.tasks.length,
    active: 0,
    paused: 0,
    completed: 0,
    watchers: {
      active: 0,
      paused: 0,
      completed: 0,
    },
  };

  for (const task of args.tasks) {
    if (task.status === 'active') tasks.active += 1;
    if (task.status === 'paused') tasks.paused += 1;
    if (task.status === 'completed') tasks.completed += 1;

    if (isWatchCiTask(task)) {
      if (task.status === 'active') tasks.watchers.active += 1;
      if (task.status === 'paused') tasks.watchers.paused += 1;
      if (task.status === 'completed') tasks.watchers.completed += 1;
    }
  }

  const usageRows = args.snapshots.flatMap(
    (snapshot) => snapshot.usageRows ?? [],
  );
  const usageFetchedAt =
    args.snapshots
      .map((snapshot) => snapshot.usageRowsFetchedAt)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null;

  return {
    generatedAt: args.now ?? new Date().toISOString(),
    services,
    rooms,
    tasks,
    usage: {
      rows: usageRows,
      fetchedAt: usageFetchedAt,
    },
  };
}
