import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWebDashboardHandler } from './web-dashboard-server.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('web dashboard server handler', () => {
  it('serves health and overview JSON without requiring Discord', async () => {
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
    });

    const health = await handler(new Request('http://localhost/api/health'));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });

    const overview = await handler(
      new Request('http://localhost/api/overview'),
    );
    expect(overview.status).toBe(200);
    const body = (await overview.json()) as {
      rooms: { total: number };
      tasks: { total: number };
    };
    expect(body.rooms.total).toBe(0);
    expect(body.tasks.total).toBe(0);
  });

  it('serves full Claude, Kimi, and Codex usage rows through overview JSON', async () => {
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [
        {
          serviceId: 'renderer',
          agentType: 'claude-code',
          assistantName: 'Claude',
          updatedAt: '2026-04-26T11:59:00.000Z',
          entries: [],
          usageRowsFetchedAt: '2026-04-26T11:59:00.000Z',
          usageRows: [
            {
              name: 'Claude1 Max',
              h5pct: 66,
              h5reset: '2h',
              d7pct: 40,
              d7reset: '4d',
            },
            {
              name: 'Kimi',
              h5pct: 10,
              h5reset: '3h',
              d7pct: 12,
              d7reset: '5d',
            },
            {
              name: 'Codex1',
              h5pct: 25,
              h5reset: '55m',
              d7pct: 35,
              d7reset: '2d',
            },
          ],
        },
      ],
      getTasks: () => [],
    });

    const overview = await handler(
      new Request('http://localhost/api/overview'),
    );
    expect(overview.status).toBe(200);
    const body = (await overview.json()) as {
      usage: { rows: Array<{ name: string }> };
    };

    expect(body.usage.rows.map((row) => row.name)).toEqual([
      'Claude1 Max',
      'Kimi',
      'Codex1',
    ]);
  });

  it('serves Vite static assets and falls back to index for SPA routes', async () => {
    const staticDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-dashboard-'),
    );
    tempDirs.push(staticDir);
    fs.writeFileSync(
      path.join(staticDir, 'index.html'),
      '<div id="root"></div>',
    );
    fs.mkdirSync(path.join(staticDir, 'assets'));
    fs.writeFileSync(
      path.join(staticDir, 'assets', 'app.js'),
      'console.log("ok")',
    );

    const handler = createWebDashboardHandler({
      staticDir,
      readStatusSnapshots: () => [],
      getTasks: () => [],
    });

    const asset = await handler(new Request('http://localhost/assets/app.js'));
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    await expect(asset.text()).resolves.toContain('console.log');

    const fallback = await handler(
      new Request('http://localhost/tasks/swarm_123'),
    );
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('content-type')).toContain('text/html');
    await expect(fallback.text()).resolves.toContain('root');
  });
});
