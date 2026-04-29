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
  getRecentDeliveredWorkItemsForChat,
  getRecentChatMessages,
  getTaskById,
  hasMessage,
  storeChatMetadata,
  storeMessage,
  updatePairedTaskIfUnchanged,
  updateTask,
} from './db.js';
import { logger } from './logger.js';
import { schedulePairedFollowUpIntent } from './message-runtime-follow-up.js';
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
import {
  createInboxDismissTracker,
  handleInboxActionRoute,
  type InboxFollowUpScheduler,
} from './web-dashboard-inbox-routes.js';
import { handleOverviewRoute } from './web-dashboard-overview-routes.js';
import {
  createRoomMessageIdCache,
  handleRoomMessageRoute,
} from './web-dashboard-room-message-routes.js';
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
const STACK_RESTART_UNIT_NAME = 'ejclaw-stack-restart.service';
const MANAGED_SERVICE_CALLER_FALLBACK_MESSAGE =
  'Stack restart unit is not installed yet. Run setup service from an external shell before retrying from a managed EJClaw service.';
const UNIT_NOT_FOUND_PATTERN =
  /(Unit .* not found|Could not find the requested service|not-found)/i;

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
  getRecentDeliveredWorkItemsForChat?: typeof getRecentDeliveredWorkItemsForChat;
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
  schedulePairedFollowUp?: InboxFollowUpScheduler;
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
  const loadRecentDeliveredWorkItemsForChat =
    opts.getRecentDeliveredWorkItemsForChat ??
    getRecentDeliveredWorkItemsForChat;
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
    loadRecentDeliveredWorkItemsForChat,
    loadRecentChatMessages,
  };

  if (opts.startBackgroundCacheRefresh !== false) {
    startRoomsTimelineCacheRefresh(roomsTimelineDeps);
  }

  const rememberRoomMessageId = createRoomMessageIdCache();
  const inboxDismissTracker = createInboxDismissTracker();
  const recentServiceRestarts: ServiceRestartRecord[] = [];
  const activeServiceRestartTargets = new Set<string>();

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

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

    const inboxActionRoute = await handleInboxActionRoute({
      url,
      request,
      jsonResponse,
      dismissTracker: inboxDismissTracker,
      enqueueMessageCheck,
      loadPairedTaskById,
      messageExists,
      mutatePairedTaskIfUnchanged,
      schedulePairedFollowUp,
      writeChatMetadata,
      writeMessage,
      now: opts.now,
    });
    if (inboxActionRoute) return inboxActionRoute;

    const roomMessageRoute = await handleRoomMessageRoute({
      url,
      request,
      jsonResponse,
      enqueueMessageCheck,
      loadRoomBindings,
      messageExists,
      rememberRoomMessageId,
      writeChatMetadata,
      writeMessage,
      now: opts.now,
    });
    if (roomMessageRoute) return roomMessageRoute;

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
      isInboxItemDismissed: inboxDismissTracker.isDismissed,
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
