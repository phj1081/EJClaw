import type { NewMessage, RegisteredGroup } from './types.js';

type JsonResponse = (
  value: unknown,
  init?: ResponseInit,
  request?: Request,
) => Response;

export type RoomMessageIdRememberer = (id: string) => boolean;

export interface RoomMessageRouteDependencies {
  enqueueMessageCheck?: (chatJid: string, groupFolder: string) => void;
  loadRoomBindings?: () => Record<string, RegisteredGroup>;
  messageExists: (chatJid: string, id: string) => boolean;
  rememberRoomMessageId: RoomMessageIdRememberer;
  writeChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  writeMessage: (message: NewMessage) => void;
}

interface RoomMessageRouteContext extends RoomMessageRouteDependencies {
  jsonResponse: JsonResponse;
  now?: () => string;
  request: Request;
  url: URL;
}

const ROOM_MESSAGE_ID_CACHE_LIMIT = 500;

export function createRoomMessageIdCache(
  limit = ROOM_MESSAGE_ID_CACHE_LIMIT,
): RoomMessageIdRememberer {
  const ids: string[] = [];
  const idSet = new Set<string>();

  return (id: string): boolean => {
    if (idSet.has(id)) return false;
    idSet.add(id);
    ids.push(id);
    if (ids.length > limit) {
      const oldest = ids.shift();
      if (oldest) idSet.delete(oldest);
    }
    return true;
  };
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

export async function handleRoomMessageRoute({
  enqueueMessageCheck,
  jsonResponse,
  loadRoomBindings,
  messageExists,
  now,
  rememberRoomMessageId,
  request,
  url,
  writeChatMetadata,
  writeMessage,
}: RoomMessageRouteContext): Promise<Response | null> {
  const messageRoomJid = parseRoomMessagePath(url.pathname);
  if (!messageRoomJid) return null;

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
    return jsonResponse({ error: 'Message text is required' }, { status: 400 });
  }

  const binding = loadRoomBindings()[messageRoomJid];
  if (!binding) {
    return jsonResponse({ error: 'Room not found' }, { status: 404 });
  }

  const timestamp = now?.() ?? new Date().toISOString();
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
