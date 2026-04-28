import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWebDashboardHandler } from './web-dashboard-server.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const tempFiles: string[] = [];

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    fs.rmSync(file, { force: true });
  }
});

describe('web dashboard attachment previews', () => {
  it('serves validated direct temp image attachments', async () => {
    const filePath = path.join(
      os.tmpdir(),
      `bar-chart-label-fit-playwright-${Date.now()}.png`,
    );
    fs.writeFileSync(filePath, ONE_PIXEL_PNG);
    tempFiles.push(filePath);
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
