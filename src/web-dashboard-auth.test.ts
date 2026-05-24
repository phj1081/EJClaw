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

describe('web dashboard API auth', () => {
  it('requires a bearer token for API routes when dashboard auth is configured', async () => {
    const handler = createWebDashboardHandler({
      authToken: 'mobile-secret',
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
      startBackgroundCacheRefresh: false,
    });

    const missing = await handler(new Request('http://localhost/api/health'));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');

    const wrong = await handler(
      new Request('http://localhost/api/health', {
        headers: { authorization: 'Bearer wrong-secret' },
      }),
    );
    expect(wrong.status).toBe(401);

    const ok = await handler(
      new Request('http://localhost/api/health', {
        headers: { authorization: 'Bearer mobile-secret' },
      }),
    );
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ ok: true });
  });

  it('accepts the mobile token header and leaves static assets readable', async () => {
    const staticDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-dashboard-auth-'),
    );
    tempDirs.push(staticDir);
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<main>ok</main>');
    const handler = createWebDashboardHandler({
      authToken: 'mobile-secret',
      staticDir,
      readStatusSnapshots: () => [],
      getTasks: () => [],
      startBackgroundCacheRefresh: false,
    });

    const asset = await handler(new Request('http://localhost/'));
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toContain('<main>ok</main>');

    const api = await handler(
      new Request('http://localhost/api/health', {
        headers: { 'x-ejclaw-dashboard-token': 'mobile-secret' },
      }),
    );
    expect(api.status).toBe(200);
  });
});
