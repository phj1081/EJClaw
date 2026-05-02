import {
  extractImageTagPaths,
  normalizeAgentOutput,
} from './agent-protocol.js';
import { isWatchCiTask } from './task-watch-status.js';
import type {
  PairedTurnAttemptRecord,
  PairedTurnRecord,
  WorkItem,
} from './db.js';
import type { StatusSnapshot, UsageRowSnapshot } from './status-dashboard.js';
import type {
  NewMessage,
  OutboundAttachment,
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
  attachments: OutboundAttachment[];
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
  progressText: string | null;
  progressUpdatedAt: string | null;
}

export interface WebDashboardRoomTurnOutput {
  id: number;
  turnNumber: number;
  role: PairedTurnOutput['role'];
  verdict: PairedTurnOutput['verdict'] | null;
  createdAt: string;
  outputText: string;
  attachments: OutboundAttachment[];
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

function buildRoomBody(value: string): string {
  return redactSensitiveText(value).trim();
}

function decodeCommonHtmlEntities(value: string): string {
  return value
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&lt;|&#60;|&#x3c;/gi, '<')
    .replace(/&gt;|&#62;|&#x3e;/gi, '>')
    .replace(/&amp;|&#38;|&#x26;/gi, '&');
}

function hasStructuredOutputHint(value: string): boolean {
  return value.includes('"ejclaw"') || /&quot;ejclaw&quot;/i.test(value);
}

function imagePathsToAttachments(paths: string[]): OutboundAttachment[] {
  return paths.map((filePath) => ({
    path: filePath,
    name: filePath.split(/[\\/]/).at(-1) || undefined,
  }));
}

function splitLegacyImageTags(
  text: string,
  attachments: OutboundAttachment[] = [],
): { text: string; attachments: OutboundAttachment[] } {
  const extracted = extractImageTagPaths(text);
  if (extracted.imagePaths.length === 0) {
    return { text, attachments };
  }
  return {
    text: extracted.cleanText,
    attachments: [
      ...attachments,
      ...imagePathsToAttachments(extracted.imagePaths),
    ],
  };
}

function normalizeStructuredVisibleContent(value: string): {
  text: string | null;
  attachments: OutboundAttachment[];
} {
  const candidates = hasStructuredOutputHint(value)
    ? [value, decodeCommonHtmlEntities(value)]
    : [value];
  for (const candidate of candidates) {
    const normalized = normalizeAgentOutput(candidate);
    if (normalized.output?.visibility === 'silent') {
      return { text: null, attachments: [] };
    }
    if (
      normalized.output?.visibility === 'public' &&
      (normalized.output.text !== candidate ||
        (normalized.output.attachments?.length ?? 0) > 0)
    ) {
      return splitLegacyImageTags(
        normalized.output.text,
        normalized.output.attachments ?? [],
      );
    }
  }

  return splitLegacyImageTags(value);
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

function pairedTaskInboxKind(
  status: PairedTask['status'],
): InboxItemKind | null {
  if (status === 'merge_ready') return 'approval';
  return null;
}

function collectInboxItems(args: {
  pairedTasks: PairedTask[];
  createdAt: string;
}): InboxItem[] {
  const items: InboxItem[] = [];

  for (const task of args.pairedTasks) {
    const kind = pairedTaskInboxKind(task.status);
    if (!kind) continue;

    items.push({
      id: `paired:${task.id}:${task.status}`,
      groupKey: `paired:${task.id}:${task.status}`,
      kind,
      severity: 'warn',
      title: task.title || task.group_folder,
      summary: task.status,
      occurredAt: task.updated_at,
      lastOccurredAt: task.updated_at,
      createdAt: args.createdAt,
      occurrences: 1,
      source: 'paired-task',
      roomJid: task.chat_jid,
      groupFolder: task.group_folder,
      serviceId: task.owner_service_id,
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

function sanitizeRoomMessage(
  message: NewMessage,
): WebDashboardRoomMessage | null {
  const normalized = normalizeStructuredVisibleContent(message.content ?? '');
  if (normalized.text === null) return null;

  return {
    id: message.id,
    sender: message.sender,
    senderName: message.sender_name || message.sender,
    content: buildRoomBody(normalized.text),
    attachments: normalized.attachments,
    timestamp: message.timestamp,
    isFromMe: !!message.is_from_me,
    isBotMessage: !!message.is_bot_message,
    sourceKind: message.message_source_kind ?? 'human',
  };
}

function roleSenderName(role: WorkItem['delivery_role']): string {
  return role ?? 'system';
}

function sanitizeCanonicalOutboundMessage(
  item: WorkItem,
): WebDashboardRoomMessage | null {
  if (item.status !== 'delivered') return null;
  const normalized = normalizeStructuredVisibleContent(item.result_payload);
  if (normalized.text === null) return null;

  return {
    id: `work:${item.id}`,
    sender: `work-item:${item.delivery_role ?? 'system'}`,
    senderName: roleSenderName(item.delivery_role ?? null),
    content: buildRoomBody(normalized.text),
    attachments:
      normalized.attachments.length > 0
        ? normalized.attachments
        : (item.attachments ?? []),
    timestamp: item.delivered_at ?? item.updated_at,
    isFromMe: false,
    isBotMessage: true,
    sourceKind: 'bot',
  };
}

function normalizeForOutboundDedupe(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function senderMatchesCanonicalOutbound(
  messageSender: string,
  outboundSender: string,
): boolean {
  const message = messageSender.trim().toLowerCase();
  const outbound = outboundSender.trim().toLowerCase();
  if (message === outbound) return true;
  const aliases: Record<string, string[]> = {
    owner: ['owner', '오너'],
    reviewer: ['reviewer', '리뷰어'],
    arbiter: ['arbiter', '중재자'],
    system: ['system', '시스템'],
  };
  return (aliases[outbound] ?? [outbound]).includes(message);
}

function isDuplicateOfCanonicalOutbound(
  message: WebDashboardRoomMessage,
  canonical: WebDashboardRoomMessage[],
): boolean {
  if (!message.isBotMessage) return false;
  const messageText = normalizeForOutboundDedupe(message.content);
  if (!messageText) return false;
  const messageTime = new Date(message.timestamp).getTime();

  return canonical.some((outbound) => {
    if (
      !senderMatchesCanonicalOutbound(message.senderName, outbound.senderName)
    ) {
      return false;
    }
    const outboundText = normalizeForOutboundDedupe(outbound.content);
    if (!outboundText) return false;
    const contentMatches =
      outboundText === messageText ||
      outboundText.startsWith(messageText) ||
      messageText.startsWith(outboundText) ||
      outboundText.includes(messageText) ||
      messageText.includes(outboundText);
    if (!contentMatches) return false;
    const outboundTime = new Date(outbound.timestamp).getTime();
    if (!Number.isFinite(messageTime) || !Number.isFinite(outboundTime)) {
      return true;
    }
    return Math.abs(outboundTime - messageTime) <= 120_000;
  });
}

function hasDiscordEchoForCanonicalOutbound(
  canonical: WebDashboardRoomMessage,
  messages: WebDashboardRoomMessage[],
): boolean {
  return messages.some((message) =>
    isDuplicateOfCanonicalOutbound(message, [canonical]),
  );
}

function compareRoomMessagesByTimestamp(
  a: WebDashboardRoomMessage,
  b: WebDashboardRoomMessage,
): number {
  const aTime = new Date(a.timestamp).getTime();
  const bTime = new Date(b.timestamp).getTime();
  if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return 0;
  return aTime - bTime;
}

function getRoomTurnActivityTimestamp(turn: PairedTurnRecord): string {
  const progressUpdatedAt =
    turn.completed_at === null && turn.progress_text?.trim()
      ? turn.progress_updated_at
      : null;
  if (progressUpdatedAt && progressUpdatedAt > turn.updated_at) {
    return progressUpdatedAt;
  }
  return turn.updated_at;
}

const TASK_STATUS_PREFIX = '⁣⁣⁣';

function isTaskStatusMessage(message: NewMessage): boolean {
  return (message.content ?? '').startsWith(TASK_STATUS_PREFIX);
}

function sanitizeRoomTurn(
  turn: PairedTurnRecord,
  attempt: PairedTurnAttemptRecord | null,
): WebDashboardRoomTurn {
  const role = attempt?.role ?? turn.role;
  const createdAt = attempt?.created_at ?? turn.created_at;
  const completedAt = attempt?.completed_at ?? turn.completed_at;
  const canonicalProgress =
    completedAt === null && turn.progress_text?.trim()
      ? {
          progressText: buildRoomBody(turn.progress_text),
          progressUpdatedAt: turn.progress_updated_at ?? turn.updated_at,
        }
      : { progressText: null, progressUpdatedAt: null };

  return {
    turnId: turn.turn_id,
    role,
    intentKind: attempt?.intent_kind ?? turn.intent_kind,
    state: attempt?.state ?? turn.state,
    attemptNo: attempt?.attempt_no ?? turn.attempt_no,
    executorServiceId: attempt?.executor_service_id ?? turn.executor_service_id,
    executorAgentType: attempt?.executor_agent_type ?? turn.executor_agent_type,
    activeRunId: attempt?.active_run_id ?? null,
    createdAt,
    updatedAt: attempt?.updated_at ?? turn.updated_at,
    completedAt,
    lastError:
      (attempt?.last_error ?? turn.last_error)
        ? buildRoomBody(attempt?.last_error ?? turn.last_error ?? '')
        : null,
    progressText: canonicalProgress.progressText,
    progressUpdatedAt: canonicalProgress.progressUpdatedAt,
  };
}

function sanitizeRoomTurnOutput(
  output: PairedTurnOutput,
): WebDashboardRoomTurnOutput | null {
  const normalized = normalizeStructuredVisibleContent(output.output_text);
  if (normalized.text === null) return null;

  return {
    id: output.id,
    turnNumber: output.turn_number,
    role: output.role,
    verdict: output.verdict ?? null,
    createdAt: output.created_at,
    outputText: buildRoomBody(normalized.text),
    attachments: normalized.attachments,
  };
}

export function buildWebDashboardRoomActivity(args: {
  serviceId: string;
  entry: StatusSnapshot['entries'][number];
  pairedTask: PairedTask | null;
  turns: PairedTurnRecord[];
  attempts: PairedTurnAttemptRecord[];
  outputs: PairedTurnOutput[];
  outboundItems?: WorkItem[];
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
      getRoomTurnActivityTimestamp(b).localeCompare(
        getRoomTurnActivityTimestamp(a),
      ),
    )[0] ?? null;
  const currentAttempt = currentTurn
    ? (latestAttemptByTurnId.get(currentTurn.turn_id) ?? null)
    : null;
  const outputLimit = args.outputLimit ?? 4;
  const sanitizedRecentMessages = args.messages
    .filter((message) => !isTaskStatusMessage(message))
    .map(sanitizeRoomMessage)
    .filter((message): message is WebDashboardRoomMessage => Boolean(message));
  const canonicalOutboundMessages = (args.outboundItems ?? [])
    .map((item) => ({
      item,
      message: sanitizeCanonicalOutboundMessage(item),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        item: WorkItem;
        message: WebDashboardRoomMessage;
      } => Boolean(candidate.message),
    )
    .filter(
      ({ item, message }) =>
        Boolean(item.delivery_message_id) ||
        hasDiscordEchoForCanonicalOutbound(message, sanitizedRecentMessages),
    )
    .map(({ message }) => message);
  const canonicalDeliveryMessageIds = new Set(
    (args.outboundItems ?? [])
      .map((item) => item.delivery_message_id)
      .filter((id): id is string => Boolean(id)),
  );
  const recentMessages = sanitizedRecentMessages
    .filter((message) => !canonicalDeliveryMessageIds.has(message.id))
    .filter(
      (message) =>
        !isDuplicateOfCanonicalOutbound(message, canonicalOutboundMessages),
    );
  const shouldExposeExecutionOutputs = args.outboundItems === undefined;

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
    messages: [...recentMessages, ...canonicalOutboundMessages].sort(
      compareRoomMessagesByTimestamp,
    ),
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
          outputs: shouldExposeExecutionOutputs
            ? args.outputs
                .slice(-outputLimit)
                .map(sanitizeRoomTurnOutput)
                .filter((output): output is WebDashboardRoomTurnOutput =>
                  Boolean(output),
                )
            : [],
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
      pairedTasks: args.pairedTasks ?? [],
      createdAt: generatedAt,
    }),
  };
}
