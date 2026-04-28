import { describe, expect, it } from 'vitest';

import type { NewMessage, RegisteredGroup } from './types.js';
import {
  createRoomMessageIdCache,
  handleRoomMessageRoute,
} from './web-dashboard-room-message-routes.js';

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

function roomMessageRequest(
  roomJid: string,
  body: unknown,
  method = 'POST',
): Request {
  return new Request(
    `http://localhost/api/rooms/${encodeURIComponent(roomJid)}/messages`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    },
  );
}

function makeDeps(
  overrides: {
    rooms?: Record<string, RegisteredGroup>;
    existingMessage?: (chatJid: string, id: string) => boolean;
    messages?: NewMessage[];
    queued?: Array<{ chatJid: string; groupFolder: string }>;
  } = {},
) {
  const messages = overrides.messages ?? [];
  const queued = overrides.queued ?? [];
  return {
    enqueueMessageCheck: (chatJid: string, groupFolder: string) => {
      queued.push({ chatJid, groupFolder });
    },
    loadRoomBindings: () =>
      overrides.rooms ?? {
        'dc:ops': {
          name: '#ops',
          folder: 'ops-room',
          added_at: '2026-04-26T05:00:00.000Z',
        },
      },
    messageExists: overrides.existingMessage ?? (() => false),
    rememberRoomMessageId: createRoomMessageIdCache(),
    writeChatMetadata: (
      _chatJid: string,
      _timestamp: string,
      _name?: string,
      _channel?: string,
      _isGroup?: boolean,
    ) => undefined,
    writeMessage: (message: NewMessage) => {
      messages.push(message);
    },
    messages,
    queued,
  };
}

describe('web dashboard room message routes', () => {
  it('expires the oldest remembered room message ids after the cache limit', () => {
    const remember = createRoomMessageIdCache(2);

    expect(remember('room:message-1')).toBe(true);
    expect(remember('room:message-1')).toBe(false);
    expect(remember('room:message-2')).toBe(true);
    expect(remember('room:message-3')).toBe(true);
    expect(remember('room:message-1')).toBe(true);
    expect(remember('room:message-2')).toBe(true);
  });

  it('injects messages and deduplicates repeated request ids', async () => {
    const messages: NewMessage[] = [];
    const queued: Array<{ chatJid: string; groupFolder: string }> = [];
    const deps = makeDeps({ messages, queued });

    const first = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      now: () => '2026-04-26T05:10:00.000Z',
      request: roomMessageRequest('dc:ops', {
        nickname: '  눈쟁이  ',
        requestId: 'compose 1',
        text: '  run a dashboard check  ',
      }),
      url: new URL('http://localhost/api/rooms/dc%3Aops/messages'),
    });
    const second = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      request: roomMessageRequest('dc:ops', {
        requestId: 'compose 1',
        text: 'second submit',
      }),
      url: new URL('http://localhost/api/rooms/dc%3Aops/messages'),
    });

    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    await expect(first?.json()).resolves.toMatchObject({
      id: 'web-compose-1',
      queued: true,
    });
    await expect(second?.json()).resolves.toMatchObject({
      id: 'web-compose-1',
      queued: false,
      duplicate: true,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      chat_jid: 'dc:ops',
      content: 'run a dashboard check',
      id: 'web-compose-1',
      message_source_kind: 'ipc_injected_human',
      sender: 'web-dashboard',
      sender_name: '눈쟁이',
      timestamp: '2026-04-26T05:10:00.000Z',
    });
    expect(queued).toEqual([{ chatJid: 'dc:ops', groupFolder: 'ops-room' }]);
  });

  it('handles fall-through and invalid room message requests', async () => {
    const deps = makeDeps({ rooms: {} });

    const fallThrough = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      request: new Request('http://localhost/api/overview'),
      url: new URL('http://localhost/api/overview'),
    });
    expect(fallThrough).toBeNull();

    const notConfigured = await handleRoomMessageRoute({
      ...deps,
      enqueueMessageCheck: undefined,
      jsonResponse,
      request: roomMessageRequest('dc:ops', { text: 'hello' }),
      url: new URL('http://localhost/api/rooms/dc%3Aops/messages'),
    });
    expect(notConfigured?.status).toBe(503);

    const empty = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      request: roomMessageRequest('dc:ops', { text: '  ' }),
      url: new URL('http://localhost/api/rooms/dc%3Aops/messages'),
    });
    expect(empty?.status).toBe(400);

    const missing = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      request: roomMessageRequest('dc:missing', { text: 'hello' }),
      url: new URL('http://localhost/api/rooms/dc%3Amissing/messages'),
    });
    expect(missing?.status).toBe(404);

    const wrongMethod = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      request: roomMessageRequest('dc:ops', null, 'GET'),
      url: new URL('http://localhost/api/rooms/dc%3Aops/messages'),
    });
    expect(wrongMethod?.status).toBe(405);
  });
});
