import { gzipSync } from 'node:zlib';

import type {
  PairedTurnAttemptRecord,
  PairedTurnRecord,
  WorkItem,
} from './db.js';
import type { StatusSnapshot } from './status-dashboard.js';
import type { NewMessage, PairedTask, PairedTurnOutput } from './types.js';
import {
  buildWebDashboardRoomActivity,
  type WebDashboardRoomActivity,
} from './web-dashboard-data.js';

type JsonResponse = (
  value: unknown,
  init?: ResponseInit,
  request?: Request,
) => Response;

export interface RoomsTimelineRouteDependencies {
  statusMaxAgeMs: number;
  readSnapshots: (maxAgeMs: number) => StatusSnapshot[];
  loadLatestPairedTaskForChat: (
    chatJid: string,
  ) => PairedTask | null | undefined;
  loadPairedTurnsForTask: (taskId: string) => PairedTurnRecord[];
  loadLatestPairedTurnForTask: (
    taskId: string,
  ) => PairedTurnRecord | null | undefined;
  loadPairedTurnAttempts: (turnId: string) => PairedTurnAttemptRecord[];
  loadPairedTurnOutputs: (taskId: string) => PairedTurnOutput[];
  loadRecentPairedTurnOutputsForChat: (
    chatJid: string,
    limit: number,
  ) => PairedTurnOutput[];
  loadRecentDeliveredWorkItemsForChat: (
    chatJid: string,
    limit: number,
  ) => WorkItem[];
  loadRecentChatMessages: (chatJid: string, limit?: number) => NewMessage[];
}

interface RoomsTimelineRouteContext extends RoomsTimelineRouteDependencies {
  url: URL;
  request: Request;
  jsonResponse: JsonResponse;
}

interface RoomsTimelineCache {
  key: string;
  builtAt: number;
  rawJson: string;
  gzipBuffer: Uint8Array;
}

const ROOMS_TIMELINE_BG_INTERVAL_MS = 2000;

let roomsTimelineCache: RoomsTimelineCache | null = null;

function parseRoomTimelinePath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/rooms\/([^/]+)\/timeline$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

function latestSnapshotEntry(
  snapshots: StatusSnapshot[],
  jid: string,
):
  | { snapshot: StatusSnapshot; entry: StatusSnapshot['entries'][number] }
  | undefined {
  return snapshots
    .flatMap((snapshot) =>
      snapshot.entries
        .filter((entry) => entry.jid === jid)
        .map((entry) => ({ snapshot, entry })),
    )
    .sort((a, b) => b.snapshot.updatedAt.localeCompare(a.snapshot.updatedAt))
    .at(0);
}

function buildRoomActivity(
  deps: RoomsTimelineRouteDependencies,
  snapshot: StatusSnapshot,
  entry: StatusSnapshot['entries'][number],
): WebDashboardRoomActivity {
  const pairedTask = deps.loadLatestPairedTaskForChat(entry.jid) ?? null;
  const turns = pairedTask ? deps.loadPairedTurnsForTask(pairedTask.id) : [];
  const attempts = turns.flatMap((turn) =>
    deps.loadPairedTurnAttempts(turn.turn_id),
  );
  return buildWebDashboardRoomActivity({
    serviceId: snapshot.serviceId,
    entry,
    pairedTask,
    turns,
    attempts,
    outputs: pairedTask ? deps.loadPairedTurnOutputs(pairedTask.id) : [],
    outboundItems: deps.loadRecentDeliveredWorkItemsForChat(entry.jid, 12),
    messages: deps.loadRecentChatMessages(entry.jid, 8),
  });
}

export function buildRoomsTimelineResult(
  deps: RoomsTimelineRouteDependencies,
): Record<string, WebDashboardRoomActivity> {
  const snapshots = deps.readSnapshots(deps.statusMaxAgeMs);
  const uniqueByJid = new Map<
    string,
    {
      snapshot: StatusSnapshot;
      entry: StatusSnapshot['entries'][number];
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

  const result: Record<string, WebDashboardRoomActivity> = {};
  for (const [jid, { snapshot, entry }] of uniqueByJid) {
    const pairedTask = deps.loadLatestPairedTaskForChat(jid) ?? null;
    const messages = deps.loadRecentChatMessages(jid, 8);
    const outputs = deps.loadRecentPairedTurnOutputsForChat(jid, 8);
    const outboundItems = deps.loadRecentDeliveredWorkItemsForChat(jid, 8);
    if (
      !pairedTask &&
      messages.length === 0 &&
      outputs.length === 0 &&
      outboundItems.length === 0
    ) {
      continue;
    }

    const latestTurn = pairedTask
      ? deps.loadLatestPairedTurnForTask(pairedTask.id)
      : null;
    const turns = latestTurn ? [latestTurn] : [];
    result[jid] = buildWebDashboardRoomActivity({
      serviceId: snapshot.serviceId,
      entry,
      pairedTask,
      turns,
      attempts: [],
      outputs,
      outboundItems,
      messages,
      outputLimit: 8,
    });
  }
  return result;
}

function computeRoomsCacheKey(deps: RoomsTimelineRouteDependencies): string {
  return deps
    .readSnapshots(deps.statusMaxAgeMs)
    .map((s) => s.updatedAt)
    .sort()
    .join('|');
}

export function ensureRoomsTimelineCache(
  deps: RoomsTimelineRouteDependencies,
): RoomsTimelineCache {
  const key = computeRoomsCacheKey(deps);
  const result = buildRoomsTimelineResult(deps);
  const rawJson = JSON.stringify(result);
  const gzipBuffer = gzipSync(new TextEncoder().encode(rawJson));
  roomsTimelineCache = {
    key,
    builtAt: Date.now(),
    rawJson,
    gzipBuffer,
  };
  return roomsTimelineCache;
}

export function startRoomsTimelineCacheRefresh(
  deps: RoomsTimelineRouteDependencies,
): void {
  setTimeout(() => {
    try {
      ensureRoomsTimelineCache(deps);
    } catch {
      /* warm-up failure is non-fatal */
    }
  }, 0);
  setInterval(() => {
    try {
      ensureRoomsTimelineCache(deps);
    } catch {
      /* refresh failure is non-fatal */
    }
  }, ROOMS_TIMELINE_BG_INTERVAL_MS).unref();
}

function createRoomsTimelineStream(
  deps: RoomsTimelineRouteDependencies,
  request: Request,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
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

      enqueue(`retry: 3000\n\n`);
      try {
        const cache = ensureRoomsTimelineCache(deps);
        lastBuiltAt = cache.builtAt;
        enqueue(`event: rooms-timeline\ndata: ${cache.rawJson}\n\n`);
      } catch {
        /* warm-up failure is non-fatal */
      }

      const tick = () => {
        if (closed) return;
        try {
          const cache = ensureRoomsTimelineCache(deps);
          if (cache.builtAt !== lastBuiltAt) {
            lastBuiltAt = cache.builtAt;
            enqueue(`event: rooms-timeline\ndata: ${cache.rawJson}\n\n`);
          } else {
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
}

function handleRoomsStream(
  deps: RoomsTimelineRouteDependencies,
  request: Request,
  jsonResponse: JsonResponse,
): Response {
  if (!isReadMethod(request.method)) {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }
  return new Response(createRoomsTimelineStream(deps, request), {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

function handleRoomsTimelineSnapshot(
  deps: RoomsTimelineRouteDependencies,
  request: Request,
  jsonResponse: JsonResponse,
): Response {
  if (!isReadMethod(request.method)) {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }
  const cache = ensureRoomsTimelineCache(deps);
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

function handleSingleRoomTimeline({
  request,
  jsonResponse,
  ...deps
}: RoomsTimelineRouteContext & { timelineRoomJid: string }): Response {
  if (!isReadMethod(request.method)) {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }

  const snapshots = deps.readSnapshots(deps.statusMaxAgeMs);
  const matched = latestSnapshotEntry(snapshots, deps.timelineRoomJid);
  if (!matched) {
    return jsonResponse({ error: 'Room timeline not found' }, { status: 404 });
  }

  return jsonResponse(buildRoomActivity(deps, matched.snapshot, matched.entry));
}

export function handleRoomTimelineRoute(
  context: RoomsTimelineRouteContext,
): Response | null {
  const timelineRoomJid = parseRoomTimelinePath(context.url.pathname);
  if (timelineRoomJid) {
    return handleSingleRoomTimeline({ ...context, timelineRoomJid });
  }
  if (context.url.pathname === '/api/stream') {
    return handleRoomsStream(context, context.request, context.jsonResponse);
  }
  if (context.url.pathname === '/api/rooms-timeline') {
    return handleRoomsTimelineSnapshot(
      context,
      context.request,
      context.jsonResponse,
    );
  }
  return null;
}
