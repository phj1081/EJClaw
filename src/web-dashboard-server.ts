import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { WEB_DASHBOARD } from './config.js';
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
import { handleOverviewRoute } from './web-dashboard-overview-routes.js';
import {
  handleRoomTimelineRoute,
  startRoomsTimelineCacheRefresh,
  type RoomsTimelineRouteDependencies,
} from './web-dashboard-room-routes.js';
import { handleSimpleGetRoute } from './web-dashboard-routes.js';
import {
  handleServiceRoute,
  type ServiceRestartRecord,
} from './web-dashboard-service-routes.js';
import { handleSettingsRoute } from './web-dashboard-settings-routes.js';
import { handleScheduledTaskRoute } from './web-dashboard-task-routes.js';

const DEFAULT_STATUS_MAX_AGE_MS = 10 * 60 * 1000;
const ROOM_MESSAGE_ID_CACHE_LIMIT = 500;
const STACK_RESTART_UNIT_NAME = 'ejclaw-stack-restart.service';
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

export type { ServiceRestartRecord } from './web-dashboard-service-routes.js';

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

type InboxAction = 'run' | 'decline' | 'dismiss';

interface InboxActionRequest {
  action: InboxAction;
  requestId: string | null;
  lastOccurredAt: string | null;
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

function isInboxAction(value: unknown): value is InboxAction {
  return value === 'run' || value === 'decline' || value === 'dismiss';
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

  const roomsTimelineDeps: RoomsTimelineRouteDependencies = {
    statusMaxAgeMs,
    readSnapshots,
    loadLatestPairedTaskForChat,
    loadPairedTurnsForTask,
    loadLatestPairedTurnForTask,
    loadPairedTurnAttempts,
    loadPairedTurnOutputs,
    loadRecentPairedTurnOutputsForChat,
    loadRecentChatMessages,
  };

  if (opts.startBackgroundCacheRefresh !== false) {
    startRoomsTimelineCacheRefresh(roomsTimelineDeps);
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

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const actionInboxId = parseInboxActionPath(url.pathname);
    const messageRoomJid = parseRoomMessagePath(url.pathname);

    const scheduledTaskRoute = await handleScheduledTaskRoute({
      url,
      request,
      jsonResponse,
      createScheduledTask,
      loadRoomBindings,
      loadTaskById,
      mutateTask,
      nudgeScheduler,
      removeTask,
      now: opts.now,
    });
    if (scheduledTaskRoute) return scheduledTaskRoute;

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

    const roomTimelineRoute = handleRoomTimelineRoute({
      url,
      request,
      jsonResponse,
      ...roomsTimelineDeps,
    });
    if (roomTimelineRoute) return roomTimelineRoute;

    const serviceRoute = await handleServiceRoute({
      url,
      request,
      jsonResponse,
      recentServiceRestarts,
      activeServiceRestartTargets,
      restartServiceStack,
      now: opts.now,
    });
    if (serviceRoute) return serviceRoute;

    const settingsRoute = await handleSettingsRoute({
      url,
      request,
      jsonResponse,
    });
    if (settingsRoute) return settingsRoute;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
    }

    const simpleGetRoute = handleSimpleGetRoute({
      url,
      statusMaxAgeMs,
      readSnapshots,
      loadTasks,
      jsonResponse,
    });
    if (simpleGetRoute) return simpleGetRoute;

    const overviewRoute = handleOverviewRoute({
      url,
      jsonResponse,
      isInboxItemDismissed,
      loadPairedTasks,
      loadTasks,
      readSnapshots,
      recentServiceRestarts,
      statusMaxAgeMs,
      now: opts.now,
    });
    if (overviewRoute) return overviewRoute;

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
