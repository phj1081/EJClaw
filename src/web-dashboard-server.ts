import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE, WEB_DASHBOARD } from './config.js';
import {
  createTask,
  deleteTask,
  getAllOpenPairedTasks,
  getAllTasks,
  getPairedTaskById,
  getTaskById,
  hasMessage,
  storeChatMetadata,
  storeMessage,
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
  buildWebDashboardOverview,
  sanitizeScheduledTask,
} from './web-dashboard-data.js';

const DEFAULT_STATUS_MAX_AGE_MS = 10 * 60 * 1000;
const ROOM_MESSAGE_ID_CACHE_LIMIT = 500;

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

export interface WebDashboardHandlerOptions {
  staticDir?: string;
  statusMaxAgeMs?: number;
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
  getPairedTaskById?: (id: string) => PairedTask | undefined;
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
  now?: () => string;
}

export interface StartedWebDashboardServer {
  url: string;
  stop: () => void;
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
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
type InboxAction = 'run';

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
  return value === 'run';
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

async function readInboxAction(request: Request): Promise<InboxAction | null> {
  try {
    const body = (await request.json()) as { action?: unknown };
    return isInboxAction(body.action) ? body.action : null;
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

function sanitizeRoomMessageRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);
  return safe || null;
}

async function readRoomMessageBody(
  request: Request,
): Promise<{ text: string; requestId: string | null } | null> {
  try {
    const body = (await request.json()) as {
      text?: unknown;
      requestId?: unknown;
    };
    if (typeof body.text !== 'string') return null;
    const text = body.text.trim();
    if (!text) return null;
    return {
      text: text.length > 8000 ? text.slice(0, 8000) : text,
      requestId: sanitizeRoomMessageRequestId(body.requestId),
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
  const schedulePairedFollowUp =
    opts.schedulePairedFollowUp ?? schedulePairedFollowUpIntent;
  const loadRoomBindings = opts.getRoomBindings;
  const writeChatMetadata = opts.storeChatMetadata ?? storeChatMetadata;
  const writeMessage = opts.storeMessage ?? storeMessage;
  const messageExists = opts.hasMessage ?? hasMessage;
  const enqueueMessageCheck = opts.enqueueMessageCheck;
  const nudgeScheduler = opts.nudgeScheduler;
  const statusMaxAgeMs = opts.statusMaxAgeMs ?? DEFAULT_STATUS_MAX_AGE_MS;
  const seenRoomMessageIds: string[] = [];
  const seenRoomMessageIdSet = new Set<string>();

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

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const actionTaskId = parseTaskActionPath(url.pathname);
    const taskId = parseTaskPath(url.pathname);
    const actionInboxId = parseInboxActionPath(url.pathname);
    const messageRoomJid = parseRoomMessagePath(url.pathname);

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

      const action = await readInboxAction(request);
      if (!action) {
        return jsonResponse({ error: 'Invalid inbox action' }, { status: 400 });
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

      if (task.status !== pairedTarget.status) {
        return jsonResponse(
          {
            error: 'Inbox item is stale',
            status: task.status,
          },
          { status: 409 },
        );
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
        sender_name: 'Web Dashboard',
        content: body.text,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
        message_source_kind: 'ipc_injected_human',
      });
      enqueueMessageCheck(messageRoomJid, binding.folder);

      return jsonResponse({ ok: true, id, queued: true });
    }

    if (url.pathname === '/api/tasks' && request.method === 'POST') {
      if (!loadRoomBindings) {
        return jsonResponse(
          { error: 'Task creation is not configured' },
          { status: 503 },
        );
      }

      const body = await readScheduledTaskMutationBody(request);
      const prompt = normalizeNonEmptyString(body?.prompt);
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
      const id = makeWebTaskId();
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

      const prompt =
        body.prompt === undefined
          ? task.prompt
          : normalizeNonEmptyString(body.prompt);
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

      const next = computeInitialNextRun(
        scheduleType,
        scheduleValue,
        opts.now?.() ?? new Date().toISOString(),
      );
      if (next.error) {
        return jsonResponse({ error: next.error }, { status: 400 });
      }

      mutateTask(taskId, {
        prompt,
        schedule_type: scheduleType,
        schedule_value: scheduleValue,
        next_run: next.nextRun,
        suspended_until: null,
      });
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
      return jsonResponse(
        buildWebDashboardOverview({
          now: opts.now?.(),
          snapshots,
          tasks,
          pairedTasks,
        }),
      );
    }

    if (url.pathname === '/api/status-snapshots') {
      return jsonResponse(readSnapshots(statusMaxAgeMs));
    }

    if (url.pathname === '/api/tasks') {
      return jsonResponse(loadTasks().map(sanitizeScheduledTask));
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
