import { describe, expect, it } from 'vitest';

import {
  handleServiceRoute,
  type ServiceRestartRecord,
} from './web-dashboard-service-routes.js';

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

function request(
  pathname: string,
  method = 'POST',
  body?: Record<string, unknown>,
): Request {
  return new Request(`http://localhost${pathname}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
  });
}

async function route({
  activeServiceRestartTargets = new Set<string>(),
  body,
  method,
  now,
  pathname,
  recentServiceRestarts = [],
  restartServiceStack = () => ['ejclaw'],
}: {
  activeServiceRestartTargets?: Set<string>;
  body?: Record<string, unknown>;
  method?: string;
  now?: () => string;
  pathname: string;
  recentServiceRestarts?: ServiceRestartRecord[];
  restartServiceStack?: () => string[];
}): Promise<Response | null> {
  return handleServiceRoute({
    url: new URL(`http://localhost${pathname}`),
    request: request(pathname, method, body),
    jsonResponse,
    recentServiceRestarts,
    activeServiceRestartTargets,
    restartServiceStack,
    now,
  });
}

describe('web dashboard service routes', () => {
  it('handles stack restarts and duplicate request ids', async () => {
    const recentServiceRestarts: ServiceRestartRecord[] = [];
    let restartCalls = 0;

    const restart = async () =>
      route({
        pathname: '/api/services/stack/actions',
        body: { action: 'restart', requestId: 'stack-restart-1' },
        recentServiceRestarts,
        restartServiceStack: () => {
          restartCalls += 1;
          return ['ejclaw', 'reviewer'];
        },
        now: () => '2026-04-28T09:20:00.000Z',
      });

    const response = await restart();
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      restart: {
        id: 'web-restart-stack-restart-1',
        target: 'stack',
        requestedAt: '2026-04-28T09:20:00.000Z',
        completedAt: '2026-04-28T09:20:00.000Z',
        status: 'success',
        services: ['ejclaw', 'reviewer'],
      },
    });
    expect(recentServiceRestarts).toHaveLength(1);
    expect(restartCalls).toBe(1);

    const duplicate = await restart();
    expect(duplicate?.status).toBe(200);
    await expect(duplicate?.json()).resolves.toMatchObject({
      ok: true,
      duplicate: true,
      restart: {
        id: 'web-restart-stack-restart-1',
        status: 'success',
      },
    });
    expect(restartCalls).toBe(1);

    const unmatched = await route({ pathname: '/api/overview' });
    expect(unmatched).toBeNull();
  });

  it('rejects invalid service actions without restarting', async () => {
    const recentServiceRestarts: ServiceRestartRecord[] = [
      {
        id: 'web-restart-failed-request',
        target: 'stack',
        requestedAt: '2026-04-28T09:10:00.000Z',
        completedAt: '2026-04-28T09:10:01.000Z',
        status: 'failed',
        services: [],
        error: 'systemctl failed',
      },
    ];
    let restartCalls = 0;
    const restartServiceStack = () => {
      restartCalls += 1;
      return ['ejclaw'];
    };

    const active = await route({
      pathname: '/api/services/stack/actions',
      body: { action: 'restart' },
      activeServiceRestartTargets: new Set(['stack']),
      restartServiceStack,
    });
    expect(active?.status).toBe(409);

    const invalidAction = await route({
      pathname: '/api/services/stack/actions',
      body: { action: 'stop' },
      restartServiceStack,
    });
    expect(invalidAction?.status).toBe(400);

    const invalidTarget = await route({
      pathname: '/api/services/ejclaw/actions',
      body: { action: 'restart' },
      restartServiceStack,
    });
    expect(invalidTarget?.status).toBe(400);

    const wrongMethod = await route({
      pathname: '/api/services/stack/actions',
      method: 'GET',
      restartServiceStack,
    });
    expect(wrongMethod?.status).toBe(405);

    const failedDuplicate = await route({
      pathname: '/api/services/stack/actions',
      body: { action: 'restart', requestId: 'failed-request' },
      recentServiceRestarts,
      restartServiceStack,
    });
    expect(failedDuplicate?.status).toBe(500);
    await expect(failedDuplicate?.json()).resolves.toMatchObject({
      error: 'systemctl failed',
      duplicate: true,
      restart: {
        id: 'web-restart-failed-request',
        status: 'failed',
      },
    });
    expect(restartCalls).toBe(0);
  });
});
