import fs from 'fs';
import path from 'path';

import { WEB_DASHBOARD } from './config.js';
import {
  deleteTask,
  getAllOpenPairedTasks,
  getAllTasks,
  getTaskById,
  hasMessage,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';
import { logger } from './logger.js';
import {
  readStatusSnapshots,
  type StatusSnapshot,
} from './status-dashboard.js';
import type {
  NewMessage,
  PairedTask,
  RegisteredGroup,
  ScheduledTask,
} from './types.js';
import {
  buildWebDashboardOverview,
  sanitizeScheduledTask,
} from './web-dashboard-data.js';

const DEFAULT_STATUS_MAX_AGE_MS = 10 * 60 * 1000;
const ROOM_MESSAGE_ID_CACHE_LIMIT = 500;

export interface WebDashboardHandlerOptions {
  staticDir?: string;
  statusMaxAgeMs?: number;
  readStatusSnapshots?: (maxAgeMs: number) => StatusSnapshot[];
  getTasks?: () => ScheduledTask[];
  getTaskById?: (id: string) => ScheduledTask | undefined;
  updateTask?: (
    id: string,
    updates: Partial<Pick<ScheduledTask, 'status' | 'suspended_until'>>,
  ) => void;
  deleteTask?: (id: string) => void;
  getPairedTasks?: () => PairedTask[];
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

function parseTaskActionPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/tasks\/([^/]+)\/actions$/);
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

function isTaskAction(value: unknown): value is TaskAction {
  return value === 'pause' || value === 'resume' || value === 'cancel';
}

async function readTaskAction(request: Request): Promise<TaskAction | null> {
  try {
    const body = (await request.json()) as { action?: unknown };
    return isTaskAction(body.action) ? body.action : null;
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

export function createWebDashboardHandler(
  opts: WebDashboardHandlerOptions = {},
): (request: Request) => Response | Promise<Response> {
  const readSnapshots = opts.readStatusSnapshots ?? readStatusSnapshots;
  const loadTasks = opts.getTasks ?? getAllTasks;
  const loadTaskById = opts.getTaskById ?? getTaskById;
  const mutateTask = opts.updateTask ?? updateTask;
  const removeTask = opts.deleteTask ?? deleteTask;
  const loadPairedTasks = opts.getPairedTasks ?? getAllOpenPairedTasks;
  const loadRoomBindings = opts.getRoomBindings;
  const writeChatMetadata = opts.storeChatMetadata ?? storeChatMetadata;
  const writeMessage = opts.storeMessage ?? storeMessage;
  const messageExists = opts.hasMessage ?? hasMessage;
  const enqueueMessageCheck = opts.enqueueMessageCheck;
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
    }),
  });
  const url = `http://${host}:${server.port}`;

  logger.info({ url, staticDir }, 'Web dashboard started');

  return {
    url,
    stop: () => server.stop(true),
  };
}
