import { isWatchCiTask } from './task-watch-status.js';
import type { PairedTurnAttemptRecord, PairedTurnRecord } from './db.js';
import type { StatusSnapshot, UsageRowSnapshot } from './status-dashboard.js';
import type {
  NewMessage,
  PairedTask,
  PairedTurnOutput,
  ScheduledTask,
} from './types.js';

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

export interface WebDashboardRoomMessage {
  id: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  isBotMessage: boolean;
  sourceKind: NonNullable<NewMessage['message_source_kind']>;
}

export interface WebDashboardRoomTurn {
  turnId: string;
  role: PairedTurnRecord['role'];
  intentKind: PairedTurnRecord['intent_kind'];
  state: PairedTurnRecord['state'];
  attemptNo: number;
  executorServiceId: string | null;
  executorAgentType: PairedTurnRecord['executor_agent_type'];
  activeRunId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export interface WebDashboardRoomTurnOutput {
  id: number;
  turnNumber: number;
  role: PairedTurnOutput['role'];
  verdict: PairedTurnOutput['verdict'] | null;
  createdAt: string;
  outputText: string;
}

export interface WebDashboardRoomActivity {
  serviceId: string;
  jid: string;
  name: string;
  folder: string;
  agentType: StatusSnapshot['agentType'];
  status: StatusSnapshot['entries'][number]['status'];
  elapsedMs: number | null;
  pendingMessages: boolean;
  pendingTasks: number;
  messages: WebDashboardRoomMessage[];
  pairedTask: {
    id: string;
    title: string | null;
    status: PairedTask['status'];
    roundTripCount: number;
    updatedAt: string;
    currentTurn: WebDashboardRoomTurn | null;
    outputs: WebDashboardRoomTurnOutput[];
  } | null;
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
  groupKey: string;
  kind: InboxItemKind;
  severity: InboxItemSeverity;
  title: string;
  summary: string;
  occurredAt: string;
  lastOccurredAt: string;
  createdAt: string;
  occurrences: number;
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
const ROOM_MESSAGE_PREVIEW_MAX_LENGTH = 900;
const ROOM_OUTPUT_PREVIEW_MAX_LENGTH = 1800;

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

function buildRoomPreview(value: string, maxLength: number): string {
  return truncateText(redactSensitiveText(value).trim(), maxLength);
}

function stableHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
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
        groupKey: `room:${snapshot.serviceId}:${entry.jid}`,
        kind: 'pending-room',
        severity: entry.pendingTasks > 0 ? 'warn' : 'info',
        title: entry.name || entry.folder || entry.jid,
        summary: parts.join(' · '),
        occurredAt: snapshot.updatedAt,
        lastOccurredAt: snapshot.updatedAt,
        createdAt: args.createdAt,
        occurrences: 1,
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
      groupKey: `paired:${task.id}:${task.status}`,
      kind,
      severity: kind === 'arbiter-request' ? 'error' : 'warn',
      title: task.title || task.group_folder,
      summary: task.status,
      occurredAt:
        kind === 'arbiter-request'
          ? (task.arbiter_requested_at ?? task.updated_at)
          : kind === 'reviewer-request'
            ? (task.review_requested_at ?? task.updated_at)
            : task.updated_at,
      lastOccurredAt:
        kind === 'arbiter-request'
          ? (task.arbiter_requested_at ?? task.updated_at)
          : kind === 'reviewer-request'
            ? (task.review_requested_at ?? task.updated_at)
            : task.updated_at,
      createdAt: args.createdAt,
      occurrences: 1,
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
      groupKey: `ci:${stableHash(result.toLowerCase())}`,
      kind: 'ci-failure',
      severity: task.status === 'paused' ? 'error' : 'warn',
      title: 'CI watcher failed',
      summary: result,
      occurredAt: task.last_run ?? task.created_at,
      lastOccurredAt: task.last_run ?? task.created_at,
      createdAt: args.createdAt,
      occurrences: 1,
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

  const groupedItems = new Map<string, InboxItem>();
  for (const item of items) {
    const existing = groupedItems.get(item.groupKey);
    if (!existing) {
      groupedItems.set(item.groupKey, item);
      continue;
    }

    const occurrences = existing.occurrences + item.occurrences;
    const severity =
      severityRank[item.severity] < severityRank[existing.severity]
        ? item.severity
        : existing.severity;
    const latest =
      item.lastOccurredAt.localeCompare(existing.lastOccurredAt) > 0
        ? item
        : existing;

    groupedItems.set(item.groupKey, {
      ...latest,
      severity,
      occurrences,
      lastOccurredAt:
        item.lastOccurredAt.localeCompare(existing.lastOccurredAt) > 0
          ? item.lastOccurredAt
          : existing.lastOccurredAt,
    });
  }

  return [...groupedItems.values()]
    .sort((a, b) => {
      const severityDelta = severityRank[a.severity] - severityRank[b.severity];
      if (severityDelta !== 0) return severityDelta;
      return b.lastOccurredAt.localeCompare(a.lastOccurredAt);
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

function sanitizeRoomMessage(message: NewMessage): WebDashboardRoomMessage {
  return {
    id: message.id,
    sender: message.sender,
    senderName: message.sender_name || message.sender,
    content: buildRoomPreview(
      message.content ?? '',
      ROOM_MESSAGE_PREVIEW_MAX_LENGTH,
    ),
    timestamp: message.timestamp,
    isFromMe: !!message.is_from_me,
    isBotMessage: !!message.is_bot_message,
    sourceKind: message.message_source_kind ?? 'human',
  };
}

function sanitizeRoomTurn(
  turn: PairedTurnRecord,
  attempt: PairedTurnAttemptRecord | null,
): WebDashboardRoomTurn {
  return {
    turnId: turn.turn_id,
    role: attempt?.role ?? turn.role,
    intentKind: attempt?.intent_kind ?? turn.intent_kind,
    state: attempt?.state ?? turn.state,
    attemptNo: attempt?.attempt_no ?? turn.attempt_no,
    executorServiceId: attempt?.executor_service_id ?? turn.executor_service_id,
    executorAgentType: attempt?.executor_agent_type ?? turn.executor_agent_type,
    activeRunId: attempt?.active_run_id ?? null,
    createdAt: attempt?.created_at ?? turn.created_at,
    updatedAt: attempt?.updated_at ?? turn.updated_at,
    completedAt: attempt?.completed_at ?? turn.completed_at,
    lastError:
      (attempt?.last_error ?? turn.last_error)
        ? buildRoomPreview(
            attempt?.last_error ?? turn.last_error ?? '',
            ROOM_MESSAGE_PREVIEW_MAX_LENGTH,
          )
        : null,
  };
}

function sanitizeRoomTurnOutput(
  output: PairedTurnOutput,
): WebDashboardRoomTurnOutput {
  return {
    id: output.id,
    turnNumber: output.turn_number,
    role: output.role,
    verdict: output.verdict ?? null,
    createdAt: output.created_at,
    outputText: buildRoomPreview(
      output.output_text,
      ROOM_OUTPUT_PREVIEW_MAX_LENGTH,
    ),
  };
}

export function buildWebDashboardRoomActivity(args: {
  serviceId: string;
  entry: StatusSnapshot['entries'][number];
  pairedTask: PairedTask | null;
  turns: PairedTurnRecord[];
  attempts: PairedTurnAttemptRecord[];
  outputs: PairedTurnOutput[];
  messages: NewMessage[];
  outputLimit?: number;
}): WebDashboardRoomActivity {
  const latestAttemptByTurnId = new Map<string, PairedTurnAttemptRecord>();
  for (const attempt of args.attempts) {
    const previous = latestAttemptByTurnId.get(attempt.turn_id);
    if (!previous || attempt.attempt_no > previous.attempt_no) {
      latestAttemptByTurnId.set(attempt.turn_id, attempt);
    }
  }
  const currentTurn =
    [...args.turns].sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at),
    )[0] ?? null;
  const currentAttempt = currentTurn
    ? (latestAttemptByTurnId.get(currentTurn.turn_id) ?? null)
    : null;
  const outputLimit = args.outputLimit ?? 4;

  return {
    serviceId: args.serviceId,
    jid: args.entry.jid,
    name: args.entry.name,
    folder: args.entry.folder,
    agentType: args.entry.agentType,
    status: args.entry.status,
    elapsedMs: args.entry.elapsedMs,
    pendingMessages: args.entry.pendingMessages,
    pendingTasks: args.entry.pendingTasks,
    messages: args.messages.map(sanitizeRoomMessage),
    pairedTask: args.pairedTask
      ? {
          id: args.pairedTask.id,
          title: args.pairedTask.title,
          status: args.pairedTask.status,
          roundTripCount: args.pairedTask.round_trip_count,
          updatedAt: args.pairedTask.updated_at,
          currentTurn: currentTurn
            ? sanitizeRoomTurn(currentTurn, currentAttempt)
            : null,
          outputs: args.outputs.slice(-outputLimit).map(sanitizeRoomTurnOutput),
        }
      : null,
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
