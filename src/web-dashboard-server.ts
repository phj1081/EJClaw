import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE, WEB_DASHBOARD } from './config.js';
import {
  createTask,
  deleteTask,
  getAllOpenPairedTasks,
  getAllTasks,
  getLatestPairedTaskForChat,
  getPairedTaskById,
  getPairedTurnAttempts,
  getPairedTurnOutputs,
  getRecentPairedTurnOutputsForChat,
  getPairedTurnsForTask,
  getLatestPairedTurnForTask,
  getRecentChatMessages,
  getRecentChatMessagesBatch,
  getTaskById,
  hasMessage,
  storeChatMetadata,
  storeMessage,
  updatePairedTaskIfUnchanged,
  updateTask,
} from './db.js';
import { logger } from './logger.js';
import { schedulePairedFollowUpIntent } from './message-runtime-follow-up.js';
import { type ScheduledPairedFollowUpIntentKind } from './paired-follow-up-scheduler.js';
import {
  readStatusSnapshots,
  type StatusSnapshot,
} from './status-dashboard.js';
import type {
  AgentType,
  NewMessage,
  PairedTask,
  RegisteredGroup,
  ScheduledTask,
} from './types.js';
import { isWatchCiTask } from './task-watch-status.js';
import {
  buildWebDashboardRoomActivity,
  buildWebDashboardOverview,
  sanitizeScheduledTask,
} from './web-dashboard-data.js';
import {
  addClaudeAccountFromToken,
  getFastMode,
  getModelConfig,
  listClaudeAccounts,
  listCodexAccounts,
  removeAccountDirectory,
  updateFastMode,
  updateModelConfig,
} from './settings-store.js';

const DEFAULT_STATUS_MAX_AGE_MS = 10 * 60 * 1000;
const ROOM_MESSAGE_ID_CACHE_LIMIT = 500;
const SERVICE_RESTART_LOG_LIMIT = 20;
const STACK_RESTART_UNIT_NAME = 'ejclaw-stack-restart.service';
const WEB_TASK_PROMPT_MAX_LENGTH = 8000;
const MANAGED_SERVICE_CALLER_FALLBACK_MESSAGE =
  'Stack restart unit is not installed yet. Run setup service from an external shell before retrying from a managed EJClaw service.';
const UNIT_NOT_FOUND_PATTERN =
  /(Unit .* not found|Could not find the requested service|not-found)/i;

type PairedFollowUpTask = Pick<
  PairedTask,
  'id' | 'status' | 'round_trip_count' | 'updated_at'
>;

type WebPairedFollowUpScheduler = (args: {
  chatJid: string;
  runId: string;
  task: PairedFollowUpTask;
  intentKind: ScheduledPairedFollowUpIntentKind;
  enqueue: () => void;
}) => boolean;

export interface ServiceRestartRecord {
  id: string;
  target: 'stack';
  requestedAt: string;
  completedAt: string | null;
  status: 'running' | 'success' | 'failed';
  services: string[];
  error?: string;
}

export interface WebDashboardHandlerOptions {
  staticDir?: string;
  statusMaxAgeMs?: number;
  startBackgroundCacheRefresh?: boolean;
  readStatusSnapshots?: (maxAgeMs: number) => StatusSnapshot[];
  getTasks?: () => ScheduledTask[];
  getTaskById?: (id: string) => ScheduledTask | undefined;
  updateTask?: (
    id: string,
    updates: Partial<
      Pick<
        ScheduledTask,
        | 'prompt'
        | 'schedule_type'
        | 'schedule_value'
        | 'next_run'
        | 'status'
        | 'suspended_until'
      >
    >,
  ) => void;
  createTask?: (task: {
    id: string;
    group_folder: string;
    chat_jid: string;
    agent_type?: AgentType | null;
    prompt: string;
    schedule_type: ScheduledTask['schedule_type'];
    schedule_value: string;
    context_mode: ScheduledTask['context_mode'];
    next_run: string | null;
    status: ScheduledTask['status'];
    created_at: string;
  }) => void;
  deleteTask?: (id: string) => void;
  getPairedTasks?: () => PairedTask[];
  getLatestPairedTaskForChat?: (chatJid: string) => PairedTask | undefined;
  getPairedTurnsForTask?: typeof getPairedTurnsForTask;
  getLatestPairedTurnForTask?: typeof getLatestPairedTurnForTask;
  getPairedTurnAttempts?: typeof getPairedTurnAttempts;
  getPairedTurnOutputs?: typeof getPairedTurnOutputs;
  getRecentPairedTurnOutputsForChat?: typeof getRecentPairedTurnOutputsForChat;
  getRecentChatMessages?: typeof getRecentChatMessages;
  getPairedTaskById?: (id: string) => PairedTask | undefined;
  updatePairedTaskIfUnchanged?: (
    id: string,
    expectedUpdatedAt: string,
    updates: Partial<
      Pick<
        PairedTask,
        'status' | 'updated_at' | 'arbiter_requested_at' | 'completion_reason'
      >
    >,
  ) => boolean;
  schedulePairedFollowUp?: WebPairedFollowUpScheduler;
  getRoomBindings?: () => Record<string, RegisteredGroup>;
  storeChatMetadata?: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  storeMessage?: (message: NewMessage) => void;
  hasMessage?: (chatJid: string, id: string) => boolean;
  enqueueMessageCheck?: (chatJid: string, groupFolder: string) => void;
  nudgeScheduler?: () => void;
  restartServiceStack?: () => string[];
  now?: () => string;
}

export interface StartedWebDashboardServer {
  url: string;
  stop: () => void;
}

const ROOMS_TIMELINE_BG_INTERVAL_MS = 2000;
let roomsTimelineCache: {
  key: string;
  builtAt: number;
  rawJson: string;
  gzipBuffer: Uint8Array;
} | null = null;

function jsonResponse(
  value: unknown,
  init?: ResponseInit,
  request?: Request,
): Response {
  const body = JSON.stringify(value);
  const acceptsGzip =
    request?.headers.get('accept-encoding')?.includes('gzip') ?? false;
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (acceptsGzip && body.length > 1024) {
    const compressed = Bun.gzipSync(new TextEncoder().encode(body));
    return new Response(compressed, {
      ...init,
      headers: {
        ...baseHeaders,
        'content-encoding': 'gzip',
        vary: 'accept-encoding',
      },
    });
  }
  return new Response(body, {
    ...init,
    headers: baseHeaders,
  });
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

function resolveStaticFile(staticDir: string, pathname: string): string | null {
  const normalizedPath = decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidate = path.resolve(staticDir, normalizedPath || 'index.html');
  const root = path.resolve(staticDir);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  const indexPath = path.join(root, 'index.html');
  if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
    return indexPath;
  }

  return null;
}

function serveStaticFile(staticDir: string, pathname: string): Response {
  const filePath = resolveStaticFile(staticDir, pathname);
  if (!filePath) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(fs.readFileSync(filePath), {
    headers: {
      'content-type': getContentType(filePath),
    },
  });
}

type TaskAction = 'pause' | 'resume' | 'cancel';
type InboxAction = 'run' | 'decline' | 'dismiss';
type ServiceAction = 'restart';

interface InboxActionRequest {
  action: InboxAction;
  requestId: string | null;
  lastOccurredAt: string | null;
}

interface ServiceActionRequest {
  action: ServiceAction;
  requestId: string | null;
}

function parseTaskPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function parseTaskActionPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/tasks\/([^/]+)\/actions$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function parseInboxActionPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/inbox\/([^/]+)\/actions$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function parseRoomMessagePath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function parseRoomTimelinePath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/rooms\/([^/]+)\/timeline$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function parseServiceActionPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/services\/([^/]+)\/actions$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function parsePairedInboxTarget(
  inboxId: string,
): { taskId: string; status: PairedTask['status'] } | null {
  if (!inboxId.startsWith('paired:')) return null;
  const rest = inboxId.slice('paired:'.length);
  const separatorIndex = rest.lastIndexOf(':');
  if (separatorIndex <= 0 || separatorIndex === rest.length - 1) return null;
  const status = rest.slice(separatorIndex + 1);
  if (!isPairedTaskStatus(status)) return null;
  return {
    taskId: rest.slice(0, separatorIndex),
    status,
  };
}

function isTaskAction(value: unknown): value is TaskAction {
  return value === 'pause' || value === 'resume' || value === 'cancel';
}

function isScheduleType(
  value: unknown,
): value is ScheduledTask['schedule_type'] {
  return value === 'cron' || value === 'interval' || value === 'once';
}

function isContextMode(value: unknown): value is ScheduledTask['context_mode'] {
  return value === 'group' || value === 'isolated';
}

function isAgentType(value: unknown): value is AgentType {
  return value === 'claude-code' || value === 'codex';
}

function isInboxAction(value: unknown): value is InboxAction {
  return value === 'run' || value === 'decline' || value === 'dismiss';
}

function isServiceAction(value: unknown): value is ServiceAction {
  return value === 'restart';
}

function isPairedTaskStatus(value: unknown): value is PairedTask['status'] {
  return (
    value === 'active' ||
    value === 'review_ready' ||
    value === 'in_review' ||
    value === 'merge_ready' ||
    value === 'completed' ||
    value === 'arbiter_requested' ||
    value === 'in_arbitration'
  );
}

async function readTaskAction(request: Request): Promise<TaskAction | null> {
  try {
    const body = (await request.json()) as { action?: unknown };
    return isTaskAction(body.action) ? body.action : null;
  } catch {
    return null;
  }
}

async function readInboxAction(
  request: Request,
): Promise<InboxActionRequest | null> {
  try {
    const body = (await request.json()) as {
      action?: unknown;
      requestId?: unknown;
      lastOccurredAt?: unknown;
    };
    if (!isInboxAction(body.action)) return null;
    return {
      action: body.action,
      requestId: sanitizeInboxActionRequestId(body.requestId),
      lastOccurredAt:
        typeof body.lastOccurredAt === 'string' && body.lastOccurredAt.trim()
          ? body.lastOccurredAt.trim()
          : null,
    };
  } catch {
    return null;
  }
}

async function readServiceAction(
  request: Request,
): Promise<ServiceActionRequest | null> {
  try {
    const body = (await request.json()) as {
      action?: unknown;
      requestId?: unknown;
    };
    if (!isServiceAction(body.action)) return null;
    return {
      action: body.action,
      requestId: sanitizeServiceActionRequestId(body.requestId),
    };
  } catch {
    return null;
  }
}

interface ScheduledTaskMutationBody {
  roomJid?: unknown;
  groupFolder?: unknown;
  prompt?: unknown;
  scheduleType?: unknown;
  scheduleValue?: unknown;
  contextMode?: unknown;
  agentType?: unknown;
  requestId?: unknown;
}

async function readScheduledTaskMutationBody(
  request: Request,
): Promise<ScheduledTaskMutationBody | null> {
  try {
    return (await request.json()) as ScheduledTaskMutationBody;
  } catch {
    return null;
  }
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeTaskPrompt(value: unknown): string | null {
  const prompt = normalizeNonEmptyString(value);
  if (!prompt) return null;
  return prompt.length > WEB_TASK_PROMPT_MAX_LENGTH
    ? prompt.slice(0, WEB_TASK_PROMPT_MAX_LENGTH)
    : prompt;
}

function computeInitialNextRun(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
  nowIso: string,
): { nextRun: string | null; error?: string } {
  if (scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(scheduleValue, {
        tz: TIMEZONE,
      });
      return { nextRun: interval.next().toISOString() };
    } catch {
      return { nextRun: null, error: 'Invalid cron schedule' };
    }
  }

  if (scheduleType === 'interval') {
    const ms = Number.parseInt(scheduleValue, 10);
    if (!Number.isFinite(ms) || ms <= 0) {
      return { nextRun: null, error: 'Invalid interval schedule' };
    }
    return {
      nextRun: new Date(new Date(nowIso).getTime() + ms).toISOString(),
    };
  }

  const date = new Date(scheduleValue);
  if (Number.isNaN(date.getTime())) {
    return { nextRun: null, error: 'Invalid timestamp schedule' };
  }
  return { nextRun: date.toISOString() };
}

function resolveTaskRoom(
  body: ScheduledTaskMutationBody,
  roomBindings: Record<string, RegisteredGroup>,
): { chatJid: string; group: RegisteredGroup } | null {
  const roomJid = normalizeNonEmptyString(body.roomJid);
  const groupFolder = normalizeNonEmptyString(body.groupFolder);
  if (roomJid && roomBindings[roomJid]) {
    return { chatJid: roomJid, group: roomBindings[roomJid] };
  }
  if (groupFolder) {
    const match = Object.entries(roomBindings).find(
      ([, group]) => group.folder === groupFolder,
    );
    if (match) return { chatJid: match[0], group: match[1] };
  }
  return null;
}

function makeWebTaskId(): string {
  return `web-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeScheduledTaskRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);
  return safe || null;
}

function makeWebTaskIdFromRequest(requestId: string | null): string {
  return requestId ? `web-task-${requestId}` : makeWebTaskId();
}

function sanitizeRoomMessageRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);
  return safe || null;
}

async function readRoomMessageBody(request: Request): Promise<{
  text: string;
  requestId: string | null;
  nickname: string | null;
} | null> {
  try {
    const body = (await request.json()) as {
      text?: unknown;
      requestId?: unknown;
      nickname?: unknown;
    };
    if (typeof body.text !== 'string') return null;
    const text = body.text.trim();
    if (!text) return null;
    let nickname: string | null = null;
    if (typeof body.nickname === 'string') {
      const trimmed = body.nickname.trim().slice(0, 32);
      if (trimmed) nickname = trimmed;
    }
    return {
      text: text.length > 8000 ? text.slice(0, 8000) : text,
      requestId: sanitizeRoomMessageRequestId(body.requestId),
      nickname,
    };
  } catch {
    return null;
  }
}

function makeWebMessageId(): string {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeWebMessageIdFromRequest(requestId: string | null): string {
  return requestId ? `web-${requestId}` : makeWebMessageId();
}

function makeWebRunId(prefix: string): string {
  return `web-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeServiceActionRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);
  return safe || null;
}

function makeServiceRestartId(requestId: string | null): string {
  return requestId
    ? `web-restart-${requestId}`
    : `web-restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeInboxActionRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);
  return safe || null;
}

function makeInboxDismissKey(
  inboxId: string,
  lastOccurredAt: string | null,
): string {
  return lastOccurredAt ? `${inboxId}\0${lastOccurredAt}` : inboxId;
}

function makeWebInboxMessageId(requestId: string | null): string {
  return requestId
    ? `web-inbox-${requestId}`
    : `web-inbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function declinedInboxMessage(status: PairedTask['status']): string {
  if (status === 'review_ready' || status === 'in_review') {
    return 'Dashboard declined review. Continue with the owner turn.';
  }
  if (status === 'merge_ready') {
    return 'Dashboard declined finalization. Continue with the owner turn.';
  }
  if (status === 'arbiter_requested' || status === 'in_arbitration') {
    return 'Dashboard declined arbiter escalation. Continue with the owner turn.';
  }
  return 'Dashboard declined this inbox item. Continue with the owner turn.';
}

function pairedFollowUpIntentForStatus(
  status: PairedTask['status'],
): ScheduledPairedFollowUpIntentKind | null {
  if (status === 'review_ready' || status === 'in_review') {
    return 'reviewer-turn';
  }
  if (status === 'merge_ready') {
    return 'finalize-owner-turn';
  }
  if (status === 'arbiter_requested' || status === 'in_arbitration') {
    return 'arbiter-turn';
  }
  return null;
}

function isRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function restartEjclawStackServices(): string[] {
  if (process.platform !== 'linux') {
    throw new Error('Service restart only supports Linux systemd services');
  }

  const services = ['ejclaw'];
  const systemctlArgs = isRoot() ? [] : ['--user'];

  try {
    execFileSync(
      'systemctl',
      [...systemctlArgs, 'start', '--wait', STACK_RESTART_UNIT_NAME],
      { stdio: 'ignore' },
    );
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr || '')
        : '';
    const stdout =
      error && typeof error === 'object' && 'stdout' in error
        ? String((error as { stdout?: unknown }).stdout || '')
        : '';
    const message =
      error instanceof Error ? error.message : `${stdout}\n${stderr}`.trim();
    const combined = `${message}\n${stdout}\n${stderr}`;
    if (!UNIT_NOT_FOUND_PATTERN.test(combined)) {
      throw error;
    }
    if (process.env.SERVICE_ID) {
      throw new Error(MANAGED_SERVICE_CALLER_FALLBACK_MESSAGE);
    }

    execFileSync('systemctl', [...systemctlArgs, 'restart', ...services], {
      stdio: 'ignore',
    });
    for (const service of services) {
      execFileSync(
        'systemctl',
        [...systemctlArgs, 'is-active', '--quiet', service],
        { stdio: 'ignore' },
      );
    }
  }

  return services;
}

export function createWebDashboardHandler(
  opts: WebDashboardHandlerOptions = {},
): (request: Request) => Response | Promise<Response> {
  const readSnapshots = opts.readStatusSnapshots ?? readStatusSnapshots;
  const loadTasks = opts.getTasks ?? getAllTasks;
  const loadTaskById = opts.getTaskById ?? getTaskById;
  const mutateTask = opts.updateTask ?? updateTask;
  const createScheduledTask = opts.createTask ?? createTask;
  const removeTask = opts.deleteTask ?? deleteTask;
  const loadPairedTasks = opts.getPairedTasks ?? getAllOpenPairedTasks;
  const loadPairedTaskById = opts.getPairedTaskById ?? getPairedTaskById;
  const mutatePairedTaskIfUnchanged =
    opts.updatePairedTaskIfUnchanged ?? updatePairedTaskIfUnchanged;
  const loadLatestPairedTaskForChat =
    opts.getLatestPairedTaskForChat ?? getLatestPairedTaskForChat;
  const loadPairedTurnsForTask =
    opts.getPairedTurnsForTask ?? getPairedTurnsForTask;
  const loadLatestPairedTurnForTask =
    opts.getLatestPairedTurnForTask ?? getLatestPairedTurnForTask;
  const loadPairedTurnOutputs =
    opts.getPairedTurnOutputs ?? getPairedTurnOutputs;
  const loadRecentPairedTurnOutputsForChat =
    opts.getRecentPairedTurnOutputsForChat ?? getRecentPairedTurnOutputsForChat;
  const loadPairedTurnAttempts =
    opts.getPairedTurnAttempts ?? getPairedTurnAttempts;
  const loadRecentChatMessages =
    opts.getRecentChatMessages ?? getRecentChatMessages;
  const schedulePairedFollowUp =
    opts.schedulePairedFollowUp ?? schedulePairedFollowUpIntent;
  const loadRoomBindings = opts.getRoomBindings;
  const writeChatMetadata = opts.storeChatMetadata ?? storeChatMetadata;
  const writeMessage = opts.storeMessage ?? storeMessage;
  const messageExists = opts.hasMessage ?? hasMessage;
  const enqueueMessageCheck = opts.enqueueMessageCheck;
  const nudgeScheduler = opts.nudgeScheduler;
  const restartServiceStack =
    opts.restartServiceStack ?? restartEjclawStackServices;
  const statusMaxAgeMs = opts.statusMaxAgeMs ?? DEFAULT_STATUS_MAX_AGE_MS;

  function buildRoomsTimelineResult(): Record<
    string,
    ReturnType<typeof buildWebDashboardRoomActivity>
  > {
    const snapshots = readSnapshots(statusMaxAgeMs);
    const uniqueByJid = new Map<
      string,
      {
        snapshot: (typeof snapshots)[number];
        entry: (typeof snapshots)[number]['entries'][number];
      }
    >();
    for (const snapshot of snapshots) {
      for (const entry of snapshot.entries) {
        const existing = uniqueByJid.get(entry.jid);
        if (
          !existing ||
          existing.snapshot.updatedAt.localeCompare(snapshot.updatedAt) < 0
        ) {
          uniqueByJid.set(entry.jid, { snapshot, entry });
        }
      }
    }
    const result: Record<
      string,
      ReturnType<typeof buildWebDashboardRoomActivity>
    > = {};
    for (const [jid, { snapshot, entry }] of uniqueByJid) {
      const pairedTask = loadLatestPairedTaskForChat(jid) ?? null;
      const messages = loadRecentChatMessages(jid, 8);
      const outputs = loadRecentPairedTurnOutputsForChat(jid, 8);
      if (!pairedTask && messages.length === 0 && outputs.length === 0)
        continue;
      const latestTurn = pairedTask
        ? loadLatestPairedTurnForTask(pairedTask.id)
        : null;
      const turns = latestTurn ? [latestTurn] : [];
      result[jid] = buildWebDashboardRoomActivity({
        serviceId: snapshot.serviceId,
        entry,
        pairedTask,
        turns,
        attempts: [],
        outputs,
        messages,
        outputLimit: 8,
      });
    }
    return result;
  }

  function computeRoomsCacheKey(): string {
    return readSnapshots(statusMaxAgeMs)
      .map((s) => s.updatedAt)
      .sort()
      .join('|');
  }

  function ensureRoomsTimelineCache(): NonNullable<typeof roomsTimelineCache> {
    const key = computeRoomsCacheKey();
    if (roomsTimelineCache && roomsTimelineCache.key === key) {
      return roomsTimelineCache;
    }
    const result = buildRoomsTimelineResult();
    const rawJson = JSON.stringify(result);
    const gzipBuffer = Bun.gzipSync(new TextEncoder().encode(rawJson));
    roomsTimelineCache = {
      key,
      builtAt: Date.now(),
      rawJson,
      gzipBuffer,
    };
    return roomsTimelineCache;
  }

  if (opts.startBackgroundCacheRefresh !== false) {
    setTimeout(() => {
      try {
        ensureRoomsTimelineCache();
      } catch {
        /* warm-up failure is non-fatal */
      }
    }, 0);
    setInterval(() => {
      try {
        ensureRoomsTimelineCache();
      } catch {
        /* refresh failure is non-fatal */
      }
    }, ROOMS_TIMELINE_BG_INTERVAL_MS).unref();
  }

  const seenRoomMessageIds: string[] = [];
  const seenRoomMessageIdSet = new Set<string>();
  const dismissedInboxKeys = new Set<string>();
  const recentServiceRestarts: ServiceRestartRecord[] = [];
  const activeServiceRestartTargets = new Set<string>();

  function rememberRoomMessageId(id: string): boolean {
    if (seenRoomMessageIdSet.has(id)) return false;
    seenRoomMessageIdSet.add(id);
    seenRoomMessageIds.push(id);
    if (seenRoomMessageIds.length > ROOM_MESSAGE_ID_CACHE_LIMIT) {
      const oldest = seenRoomMessageIds.shift();
      if (oldest) seenRoomMessageIdSet.delete(oldest);
    }
    return true;
  }

  function isInboxItemDismissed(item: {
    id: string;
    lastOccurredAt: string;
  }): boolean {
    return (
      dismissedInboxKeys.has(item.id) ||
      dismissedInboxKeys.has(makeInboxDismissKey(item.id, item.lastOccurredAt))
    );
  }

  function rememberServiceRestart(record: ServiceRestartRecord): void {
    recentServiceRestarts.unshift(record);
    if (recentServiceRestarts.length > SERVICE_RESTART_LOG_LIMIT) {
      recentServiceRestarts.length = SERVICE_RESTART_LOG_LIMIT;
    }
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const actionTaskId = parseTaskActionPath(url.pathname);
    const taskId = parseTaskPath(url.pathname);
    const actionInboxId = parseInboxActionPath(url.pathname);
    const messageRoomJid = parseRoomMessagePath(url.pathname);
    const timelineRoomJid = parseRoomTimelinePath(url.pathname);
    const actionServiceId = parseServiceActionPath(url.pathname);

    if (actionTaskId) {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
      }

      const action = await readTaskAction(request);
      if (!action) {
        return jsonResponse({ error: 'Invalid task action' }, { status: 400 });
      }

      const task = loadTaskById(actionTaskId);
      if (!task) {
        return jsonResponse({ error: 'Task not found' }, { status: 404 });
      }

      if (task.status === 'completed' && action !== 'cancel') {
        return jsonResponse(
          { error: 'Completed tasks cannot be changed' },
          { status: 409 },
        );
      }

      if (action === 'cancel') {
        removeTask(actionTaskId);
        return jsonResponse({ ok: true, id: actionTaskId, deleted: true });
      }

      mutateTask(actionTaskId, {
        status: action === 'pause' ? 'paused' : 'active',
        suspended_until: null,
      });

      const updatedTask = loadTaskById(actionTaskId);
      return jsonResponse({
        ok: true,
        task: updatedTask ? sanitizeScheduledTask(updatedTask) : null,
      });
    }

    if (actionInboxId) {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
      }

      const inboxRequest = await readInboxAction(request);
      if (!inboxRequest) {
        return jsonResponse({ error: 'Invalid inbox action' }, { status: 400 });
      }

      if (inboxRequest.action === 'dismiss') {
        dismissedInboxKeys.add(
          makeInboxDismissKey(actionInboxId, inboxRequest.lastOccurredAt),
        );
        return jsonResponse({ ok: true, id: actionInboxId, dismissed: true });
      }

      const pairedTarget = parsePairedInboxTarget(actionInboxId);
      if (!pairedTarget) {
        return jsonResponse(
          { error: 'Unsupported inbox action target' },
          { status: 400 },
        );
      }

      if (!enqueueMessageCheck) {
        return jsonResponse(
          { error: 'Paired follow-up queue is not configured' },
          { status: 503 },
        );
      }

      const task = loadPairedTaskById(pairedTarget.taskId);
      if (!task) {
        return jsonResponse(
          { error: 'Paired task not found' },
          { status: 404 },
        );
      }

      if (inboxRequest.action === 'decline') {
        const messageId = makeWebInboxMessageId(inboxRequest.requestId);
        if (inboxRequest.requestId && messageExists(task.chat_jid, messageId)) {
          return jsonResponse({
            ok: true,
            id: actionInboxId,
            taskId: task.id,
            queued: false,
            duplicate: true,
          });
        }
      }

      if (task.status !== pairedTarget.status) {
        return jsonResponse(
          {
            error: 'Inbox item is stale',
            status: task.status,
          },
          { status: 409 },
        );
      }

      if (inboxRequest.action === 'decline') {
        const timestamp = opts.now?.() ?? new Date().toISOString();
        const messageId = makeWebInboxMessageId(inboxRequest.requestId);
        const updates: Partial<
          Pick<
            PairedTask,
            | 'status'
            | 'updated_at'
            | 'arbiter_requested_at'
            | 'completion_reason'
          >
        > = {
          status: 'active',
          updated_at: timestamp,
        };
        if (
          task.status === 'arbiter_requested' ||
          task.status === 'in_arbitration'
        ) {
          updates.arbiter_requested_at = null;
        }

        const updated = mutatePairedTaskIfUnchanged(
          task.id,
          task.updated_at,
          updates,
        );
        if (!updated) {
          return jsonResponse(
            { error: 'Inbox item is stale', status: task.status },
            { status: 409 },
          );
        }

        writeChatMetadata(
          task.chat_jid,
          timestamp,
          undefined,
          'web-dashboard',
          true,
        );
        writeMessage({
          id: messageId,
          chat_jid: task.chat_jid,
          sender: 'web-dashboard',
          sender_name: 'Web Dashboard',
          content: declinedInboxMessage(task.status),
          timestamp,
          is_from_me: false,
          is_bot_message: false,
          message_source_kind: 'ipc_injected_human',
        });
        enqueueMessageCheck(task.chat_jid, task.group_folder);

        return jsonResponse({
          ok: true,
          id: actionInboxId,
          taskId: task.id,
          status: 'active',
          queued: true,
        });
      }

      const intentKind = pairedFollowUpIntentForStatus(task.status);
      if (!intentKind) {
        return jsonResponse(
          { error: 'Paired task is not actionable' },
          { status: 409 },
        );
      }

      const queued = schedulePairedFollowUp({
        chatJid: task.chat_jid,
        runId: makeWebRunId('inbox'),
        task,
        intentKind,
        enqueue: () => enqueueMessageCheck(task.chat_jid, task.group_folder),
      });

      return jsonResponse({
        ok: true,
        id: actionInboxId,
        taskId: task.id,
        intentKind,
        queued,
      });
    }

    if (messageRoomJid) {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
      }

      if (!loadRoomBindings || !enqueueMessageCheck) {
        return jsonResponse(
          { error: 'Room message injection is not configured' },
          { status: 503 },
        );
      }

      const body = await readRoomMessageBody(request);
      if (!body) {
        return jsonResponse(
          { error: 'Message text is required' },
          { status: 400 },
        );
      }

      const binding = loadRoomBindings()[messageRoomJid];
      if (!binding) {
        return jsonResponse({ error: 'Room not found' }, { status: 404 });
      }

      const timestamp = opts.now?.() ?? new Date().toISOString();
      const id = makeWebMessageIdFromRequest(body.requestId);
      if (body.requestId && messageExists(messageRoomJid, id)) {
        return jsonResponse({ ok: true, id, queued: false, duplicate: true });
      }

      if (!rememberRoomMessageId(`${messageRoomJid}:${id}`)) {
        return jsonResponse({ ok: true, id, queued: false, duplicate: true });
      }

      writeChatMetadata(
        messageRoomJid,
        timestamp,
        binding.name,
        'web-dashboard',
        true,
      );
      writeMessage({
        id,
        chat_jid: messageRoomJid,
        sender: 'web-dashboard',
        sender_name: body.nickname ?? 'Web Dashboard',
        content: body.text,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
        message_source_kind: 'ipc_injected_human',
      });
      enqueueMessageCheck(messageRoomJid, binding.folder);

      return jsonResponse({ ok: true, id, queued: true });
    }

    if (timelineRoomJid) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
      }

      const snapshots = readSnapshots(statusMaxAgeMs);
      const matched = snapshots
        .flatMap((snapshot) =>
          snapshot.entries
            .filter((entry) => entry.jid === timelineRoomJid)
            .map((entry) => ({ snapshot, entry })),
        )
        .sort((a, b) =>
          b.snapshot.updatedAt.localeCompare(a.snapshot.updatedAt),
        )
        .at(0);
      if (!matched) {
        return jsonResponse(
          { error: 'Room timeline not found' },
          { status: 404 },
        );
      }

      const pairedTask = loadLatestPairedTaskForChat(timelineRoomJid) ?? null;
      const turns = pairedTask ? loadPairedTurnsForTask(pairedTask.id) : [];
      const attempts = turns.flatMap((turn) =>
        loadPairedTurnAttempts(turn.turn_id),
      );
      return jsonResponse(
        buildWebDashboardRoomActivity({
          serviceId: matched.snapshot.serviceId,
          entry: matched.entry,
          pairedTask,
          turns,
          attempts,
          outputs: pairedTask ? loadPairedTurnOutputs(pairedTask.id) : [],
          messages: loadRecentChatMessages(timelineRoomJid, 8),
        }),
      );
    }

    if (actionServiceId) {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
      }
      if (actionServiceId !== 'stack') {
        return jsonResponse(
          { error: 'Unsupported service restart target' },
          { status: 400 },
        );
      }

      const serviceRequest = await readServiceAction(request);
      if (!serviceRequest) {
        return jsonResponse(
          { error: 'Invalid service action' },
          { status: 400 },
        );
      }

      const id = makeServiceRestartId(serviceRequest.requestId);
      const previous = recentServiceRestarts.find((record) => record.id === id);
      if (serviceRequest.requestId && previous) {
        if (previous.status === 'failed') {
          return jsonResponse(
            {
              error: previous.error ?? 'Service restart failed',
              duplicate: true,
              restart: previous,
            },
            { status: 500 },
          );
        }
        return jsonResponse({
          ok: true,
          duplicate: true,
          restart: previous,
        });
      }

      if (activeServiceRestartTargets.has(actionServiceId)) {
        return jsonResponse(
          { error: 'Service restart is already running' },
          { status: 409 },
        );
      }

      const requestedAt = opts.now?.() ?? new Date().toISOString();
      const record: ServiceRestartRecord = {
        id,
        target: 'stack',
        requestedAt,
        completedAt: null,
        status: 'running',
        services: [],
      };
      rememberServiceRestart(record);
      activeServiceRestartTargets.add(actionServiceId);

      try {
        const services = restartServiceStack();
        record.completedAt = opts.now?.() ?? new Date().toISOString();
        record.status = 'success';
        record.services = services;
        return jsonResponse({ ok: true, restart: record });
      } catch (error) {
        record.completedAt = opts.now?.() ?? new Date().toISOString();
        record.status = 'failed';
        record.error = error instanceof Error ? error.message : String(error);
        return jsonResponse(
          { error: record.error, restart: record },
          { status: 500 },
        );
      } finally {
        activeServiceRestartTargets.delete(actionServiceId);
      }
    }

    if (
      url.pathname === '/api/settings/models' &&
      (request.method === 'PUT' || request.method === 'PATCH')
    ) {
      let body: unknown = null;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
      }
      if (!body || typeof body !== 'object') {
        return jsonResponse(
          { error: 'Body must be a JSON object' },
          { status: 400 },
        );
      }
      try {
        const next = updateModelConfig(body as Record<string, unknown>);
        return jsonResponse(next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ error: message }, { status: 500 });
      }
    }

    if (
      url.pathname === '/api/settings/fast-mode' &&
      (request.method === 'PUT' || request.method === 'PATCH')
    ) {
      let body: unknown = null;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
      }
      if (!body || typeof body !== 'object') {
        return jsonResponse(
          { error: 'Body must be a JSON object' },
          { status: 400 },
        );
      }
      try {
        const next = updateFastMode(body as Record<string, unknown>);
        return jsonResponse(next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse({ error: message }, { status: 500 });
      }
    }

    {
      const accountAddMatch = url.pathname.match(
        /^\/api\/settings\/accounts\/(claude)$/,
      );
      if (accountAddMatch && request.method === 'POST') {
        let body: { token?: unknown } | null = null;
        try {
          body = (await request.json()) as { token?: unknown };
        } catch {
          return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
        }
        const token = typeof body?.token === 'string' ? body.token.trim() : '';
        if (!token) {
          return jsonResponse({ error: 'token is required' }, { status: 400 });
        }
        try {
          const result = addClaudeAccountFromToken(token);
          return jsonResponse({ ok: true, ...result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResponse({ error: message }, { status: 400 });
        }
      }
    }

    {
      const accountDelMatch = url.pathname.match(
        /^\/api\/settings\/accounts\/(claude|codex)\/(\d+)$/,
      );
      if (accountDelMatch && request.method === 'DELETE') {
        const provider = accountDelMatch[1] as 'claude' | 'codex';
        const index = Number.parseInt(accountDelMatch[2], 10);
        try {
          removeAccountDirectory(provider, index);
          return jsonResponse({ ok: true, provider, index });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResponse({ error: message }, { status: 400 });
        }
      }
    }

    if (url.pathname === '/api/tasks' && request.method === 'POST') {
      if (!loadRoomBindings) {
        return jsonResponse(
          { error: 'Task creation is not configured' },
          { status: 503 },
        );
      }

      const body = await readScheduledTaskMutationBody(request);
      const prompt = normalizeTaskPrompt(body?.prompt);
      const scheduleType =
        body && isScheduleType(body.scheduleType) ? body.scheduleType : null;
      const scheduleValue = normalizeNonEmptyString(body?.scheduleValue);
      if (!body || !prompt || !scheduleType || !scheduleValue) {
        return jsonResponse(
          {
            error:
              'Task prompt, schedule type, and schedule value are required',
          },
          { status: 400 },
        );
      }

      const room = resolveTaskRoom(body, loadRoomBindings());
      if (!room) {
        return jsonResponse({ error: 'Room not found' }, { status: 404 });
      }

      const nowIso = opts.now?.() ?? new Date().toISOString();
      const next = computeInitialNextRun(scheduleType, scheduleValue, nowIso);
      if (next.error) {
        return jsonResponse({ error: next.error }, { status: 400 });
      }

      const contextMode = isContextMode(body.contextMode)
        ? body.contextMode
        : 'isolated';
      const agentType = isAgentType(body.agentType)
        ? body.agentType
        : (room.group.agentType ?? 'claude-code');
      const requestId = sanitizeScheduledTaskRequestId(body.requestId);
      const id = makeWebTaskIdFromRequest(requestId);
      const existing = requestId ? loadTaskById(id) : undefined;
      if (existing) {
        return jsonResponse({
          ok: true,
          duplicate: true,
          task: sanitizeScheduledTask(existing),
        });
      }

      createScheduledTask({
        id,
        group_folder: room.group.folder,
        chat_jid: room.chatJid,
        agent_type: agentType,
        prompt,
        schedule_type: scheduleType,
        schedule_value: scheduleValue,
        context_mode: contextMode,
        next_run: next.nextRun,
        status: 'active',
        created_at: nowIso,
      });

      const created = loadTaskById(id);
      if (
        next.nextRun &&
        new Date(next.nextRun).getTime() <= new Date(nowIso).getTime()
      ) {
        nudgeScheduler?.();
      }
      return jsonResponse({
        ok: true,
        task: created ? sanitizeScheduledTask(created) : null,
      });
    }

    if (taskId && request.method === 'PATCH') {
      const task = loadTaskById(taskId);
      if (!task) {
        return jsonResponse({ error: 'Task not found' }, { status: 404 });
      }
      if (task.status === 'completed') {
        return jsonResponse(
          { error: 'Completed tasks cannot be edited' },
          { status: 409 },
        );
      }
      if (isWatchCiTask(task)) {
        return jsonResponse(
          { error: 'CI watchers cannot be edited here' },
          { status: 409 },
        );
      }

      const body = await readScheduledTaskMutationBody(request);
      if (!body) {
        return jsonResponse({ error: 'Invalid task update' }, { status: 400 });
      }
      if (
        body.roomJid !== undefined ||
        body.groupFolder !== undefined ||
        body.contextMode !== undefined ||
        body.agentType !== undefined
      ) {
        return jsonResponse(
          { error: 'Task room, context, and agent cannot be edited here' },
          { status: 400 },
        );
      }

      const prompt =
        body.prompt === undefined
          ? task.prompt
          : normalizeTaskPrompt(body.prompt);
      const scheduleChanged =
        body.scheduleType !== undefined || body.scheduleValue !== undefined;
      const scheduleType =
        body.scheduleType === undefined
          ? task.schedule_type
          : isScheduleType(body.scheduleType)
            ? body.scheduleType
            : null;
      const scheduleValue =
        body.scheduleValue === undefined
          ? task.schedule_value
          : normalizeNonEmptyString(body.scheduleValue);
      if (!prompt || !scheduleType || !scheduleValue) {
        return jsonResponse({ error: 'Invalid task update' }, { status: 400 });
      }

      const updates: Parameters<typeof mutateTask>[1] = {
        prompt,
        schedule_type: scheduleType,
        schedule_value: scheduleValue,
      };

      if (scheduleChanged) {
        const next = computeInitialNextRun(
          scheduleType,
          scheduleValue,
          opts.now?.() ?? new Date().toISOString(),
        );
        if (next.error) {
          return jsonResponse({ error: next.error }, { status: 400 });
        }
        updates.next_run = next.nextRun;
        updates.suspended_until = null;
      }

      mutateTask(taskId, updates);
      const updatedTask = loadTaskById(taskId);
      return jsonResponse({
        ok: true,
        task: updatedTask ? sanitizeScheduledTask(updatedTask) : null,
      });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
    }

    if (url.pathname === '/api/health') {
      return jsonResponse({ ok: true });
    }

    if (url.pathname === '/api/overview') {
      const snapshots = readSnapshots(statusMaxAgeMs);
      const tasks = loadTasks();
      const pairedTasks = loadPairedTasks();
      const overview = buildWebDashboardOverview({
        now: opts.now?.(),
        snapshots,
        tasks,
        pairedTasks,
      });
      return jsonResponse({
        ...overview,
        operations: {
          serviceRestarts: recentServiceRestarts,
        },
        inbox: overview.inbox.filter((item) => !isInboxItemDismissed(item)),
      });
    }

    if (url.pathname === '/api/status-snapshots') {
      return jsonResponse(readSnapshots(statusMaxAgeMs));
    }

    if (url.pathname === '/api/tasks') {
      return jsonResponse(loadTasks().map(sanitizeScheduledTask));
    }

    if (url.pathname === '/api/settings/accounts') {
      return jsonResponse({
        claude: listClaudeAccounts(),
        codex: listCodexAccounts(),
      });
    }

    if (url.pathname === '/api/settings/models') {
      return jsonResponse(getModelConfig());
    }

    if (url.pathname === '/api/settings/fast-mode') {
      return jsonResponse(getFastMode());
    }

    if (url.pathname === '/api/stream') {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          let lastBuiltAt = 0;
          let closed = false;

          const enqueue = (chunk: string) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              closed = true;
            }
          };

          // Initial: send retry hint and seed event
          enqueue(`retry: 3000\n\n`);
          try {
            const cache = ensureRoomsTimelineCache();
            lastBuiltAt = cache.builtAt;
            enqueue(`event: rooms-timeline\ndata: ${cache.rawJson}\n\n`);
          } catch {
            /* warm-up failure is non-fatal */
          }

          const tick = () => {
            if (closed) return;
            try {
              const cache = ensureRoomsTimelineCache();
              if (cache.builtAt !== lastBuiltAt) {
                lastBuiltAt = cache.builtAt;
                enqueue(`event: rooms-timeline\ndata: ${cache.rawJson}\n\n`);
              } else {
                // heartbeat to keep connection alive through proxies
                enqueue(`: ping ${Date.now()}\n\n`);
              }
            } catch {
              /* skip this tick */
            }
          };

          const interval = setInterval(tick, 1500);
          const close = () => {
            if (closed) return;
            closed = true;
            clearInterval(interval);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };
          request.signal.addEventListener('abort', close);
        },
      });

      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      });
    }

    if (url.pathname === '/api/rooms-timeline') {
      const cache = ensureRoomsTimelineCache();
      const acceptsGzip =
        request.headers.get('accept-encoding')?.includes('gzip') ?? false;
      if (acceptsGzip) {
        return new Response(cache.gzipBuffer, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-encoding': 'gzip',
            vary: 'accept-encoding',
            'x-cache-age': String(Date.now() - cache.builtAt),
          },
        });
      }
      return new Response(cache.rawJson, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-cache-age': String(Date.now() - cache.builtAt),
        },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ error: 'Not found' }, { status: 404 });
    }

    if (!opts.staticDir) {
      return new Response('Dashboard static directory is not configured', {
        status: 404,
      });
    }

    return serveStaticFile(opts.staticDir, url.pathname);
  };
}

export function startWebDashboardServer(
  opts: {
    enabled?: boolean;
    host?: string;
    port?: number;
    staticDir?: string;
    getRoomBindings?: () => Record<string, RegisteredGroup>;
    enqueueMessageCheck?: (chatJid: string, groupFolder: string) => void;
    nudgeScheduler?: () => void;
  } = {},
): StartedWebDashboardServer | null {
  const enabled = opts.enabled ?? WEB_DASHBOARD.enabled;
  if (!enabled) return null;

  const host = opts.host ?? WEB_DASHBOARD.host;
  const port = opts.port ?? WEB_DASHBOARD.port;
  const staticDir = opts.staticDir ?? WEB_DASHBOARD.staticDir;
  const server = Bun.serve({
    hostname: host,
    port,
    fetch: createWebDashboardHandler({
      staticDir,
      getRoomBindings: opts.getRoomBindings,
      enqueueMessageCheck: opts.enqueueMessageCheck,
      nudgeScheduler: opts.nudgeScheduler,
    }),
  });
  const url = `http://${host}:${server.port}`;

  logger.info({ url, staticDir }, 'Web dashboard started');

  return {
    url,
    stop: () => server.stop(true),
  };
}
