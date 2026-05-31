import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const cleanupDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe('paired turn output attachments', () => {
  it('copies attachments into durable data storage for reviewer access', async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-turn-output-data-'),
    );
    const sourceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-turn-output-source-'),
    );
    cleanupDirs.push(dataDir, sourceDir);
    vi.stubEnv('EJCLAW_DATA_DIR', dataDir);

    const sourcePath = path.join(sourceDir, 'render.png');
    fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);

    const { persistPairedTurnOutputAttachments } =
      await import('./paired-turn-output-attachments.js');
    const [attachment] = persistPairedTurnOutputAttachments({
      taskId: 'task:with/slashes',
      turnNumber: 3,
      role: 'owner',
      attachments: [
        {
          path: sourcePath,
          name: '../settings-v0.1.92-deployed-390.png',
          mime: 'image/png',
        },
      ],
    });

    expect(attachment.path).toContain(
      path.join('attachments', 'paired-turn-outputs', 'task-with-slashes'),
    );
    expect(attachment.path).not.toBe(sourcePath);
    expect(fs.readFileSync(attachment.path)).toEqual(ONE_PIXEL_PNG);
    expect(attachment.name).toBe('settings-v0.1.92-deployed-390.png');
  });
});
