import { isWatchCiTask } from './task-watch-status.js';
import type { StatusSnapshot, UsageRowSnapshot } from './status-dashboard.js';
import type { PairedTask, ScheduledTask } from './types.js';

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
  inbox: InboxItem[];
}

export type InboxItemKind =
  | 'pending-room'
  | 'reviewer-request'
  | 'approval'
  | 'arbiter-request'
  | 'ci-failure'
  | 'mention';

export type InboxItemSeverity = 'info' | 'warn' | 'error';

export interface InboxItem {
  id: string;
  kind: InboxItemKind;
  severity: InboxItemSeverity;
  title: string;
  summary: string;
  occurredAt: string;
  createdAt: string;
  source: 'status-snapshot' | 'paired-task' | 'scheduled-task';
  roomJid?: string;
  roomName?: string;
  groupFolder?: string;
  serviceId?: string;
  taskId?: string;
  taskStatus?: string;
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

function buildInboxPreview(value: string): string {
  return truncateText(redactSensitiveText(value).replace(/\s+/g, ' ').trim());
}

function collectUsageRows(snapshots: StatusSnapshot[]): UsageRowSnapshot[] {
  const rows: UsageRowSnapshot[] = [];
  const seen = new Set<string>();
  const sortedSnapshots = [...snapshots].sort((a, b) =>
    (b.usageRowsFetchedAt ?? b.updatedAt).localeCompare(
      a.usageRowsFetchedAt ?? a.updatedAt,
    ),
  );

  for (const snapshot of sortedSnapshots) {
    for (const row of snapshot.usageRows ?? []) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      rows.push(row);
    }
  }

  return rows;
}

function failedTaskResult(task: ScheduledTask): string | null {
  if (!task.last_result) return null;
  const normalized = task.last_result.toLowerCase();
  if (
    normalized.includes('fail') ||
    normalized.includes('error') ||
    normalized.includes('timeout') ||
    normalized.includes('cancel') ||
    normalized.includes('reject')
  ) {
    return buildInboxPreview(task.last_result);
  }
  return null;
}

function pairedTaskInboxKind(
  status: PairedTask['status'],
): InboxItemKind | null {
  if (status === 'merge_ready') return 'approval';
  if (status === 'review_ready' || status === 'in_review') {
    return 'reviewer-request';
  }
  if (status === 'arbiter_requested' || status === 'in_arbitration') {
    return 'arbiter-request';
  }
  return null;
}

function collectInboxItems(args: {
  snapshots: StatusSnapshot[];
  tasks: ScheduledTask[];
  pairedTasks: PairedTask[];
  createdAt: string;
}): InboxItem[] {
  const items: InboxItem[] = [];

  for (const snapshot of args.snapshots) {
    for (const entry of snapshot.entries) {
      if (!entry.pendingMessages && entry.pendingTasks === 0) continue;

      const parts: string[] = [];
      if (entry.pendingMessages) parts.push('pending messages');
      if (entry.pendingTasks > 0) parts.push(`${entry.pendingTasks} tasks`);

      items.push({
        id: `room:${snapshot.serviceId}:${entry.jid}`,
        kind: 'pending-room',
        severity: entry.pendingTasks > 0 ? 'warn' : 'info',
        title: entry.name || entry.folder || entry.jid,
        summary: parts.join(' · '),
        occurredAt: snapshot.updatedAt,
        createdAt: args.createdAt,
        source: 'status-snapshot',
        roomJid: entry.jid,
        roomName: entry.name,
        groupFolder: entry.folder,
        serviceId: snapshot.serviceId,
      });
    }
  }

  for (const task of args.pairedTasks) {
    const kind = pairedTaskInboxKind(task.status);
    if (!kind) continue;

    items.push({
      id: `paired:${task.id}:${task.status}`,
      kind,
      severity:
        kind === 'approval' || kind === 'arbiter-request' ? 'error' : 'warn',
      title: task.title || task.group_folder,
      summary: task.status,
      occurredAt:
        kind === 'arbiter-request'
          ? (task.arbiter_requested_at ?? task.updated_at)
          : kind === 'reviewer-request'
            ? (task.review_requested_at ?? task.updated_at)
            : task.updated_at,
      createdAt: args.createdAt,
      source: 'paired-task',
      roomJid: task.chat_jid,
      groupFolder: task.group_folder,
      serviceId:
        kind === 'reviewer-request'
          ? task.reviewer_service_id
          : task.owner_service_id,
      taskId: task.id,
      taskStatus: task.status,
    });
  }

  for (const task of args.tasks) {
    if (!isWatchCiTask(task)) continue;
    const result = failedTaskResult(task);
    if (!result) continue;

    items.push({
      id: `ci:${task.id}`,
      kind: 'ci-failure',
      severity: task.status === 'paused' ? 'error' : 'warn',
      title: 'CI watcher failed',
      summary: result,
      occurredAt: task.last_run ?? task.created_at,
      createdAt: args.createdAt,
      source: 'scheduled-task',
      roomJid: task.chat_jid,
      groupFolder: task.group_folder,
      serviceId: task.agent_type ?? undefined,
      taskId: task.id,
      taskStatus: task.status,
    });
  }

  const severityRank: Record<InboxItemSeverity, number> = {
    error: 0,
    warn: 1,
    info: 2,
  };

  return items
    .sort((a, b) => {
      const severityDelta = severityRank[a.severity] - severityRank[b.severity];
      if (severityDelta !== 0) return severityDelta;
      return b.occurredAt.localeCompare(a.occurredAt);
    })
    .slice(0, 50);
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
  pairedTasks?: PairedTask[];
}): WebDashboardOverview {
  const generatedAt = args.now ?? new Date().toISOString();
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

  const usageRows = collectUsageRows(args.snapshots);
  const usageFetchedAt =
    args.snapshots
      .map((snapshot) => snapshot.usageRowsFetchedAt)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null;

  return {
    generatedAt,
    services,
    rooms,
    tasks,
    usage: {
      rows: usageRows,
      fetchedAt: usageFetchedAt,
    },
    inbox: collectInboxItems({
      snapshots: args.snapshots,
      tasks: args.tasks,
      pairedTasks: args.pairedTasks ?? [],
      createdAt: generatedAt,
    }),
  };
}
