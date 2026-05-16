import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWebDashboardHandler } from './web-dashboard-server.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe('web dashboard attachment previews', () => {
  it('serves validated direct temp image attachments', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-dashboard-attachment-'),
    );
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'bar-chart-label-fit-playwright.png');
    fs.writeFileSync(filePath, ONE_PIXEL_PNG);
    const handler = createWebDashboardHandler({
      readStatusSnapshots: () => [],
      getTasks: () => [],
      getPairedTasks: () => [],
    });

    const response = await handler(
      new Request(
        `http://localhost/api/attachments?path=${encodeURIComponent(filePath)}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ONE_PIXEL_PNG);
  });
});
