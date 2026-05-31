import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseAppServerInput } from '../src/app-server-input.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe('codex app-server input', () => {
  it('loads labeled image tags as local image input items', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-codex-image-'));
    cleanupDirs.push(dir);
    const imagePath = path.join(dir, 'settings-v0.1.92-deployed-390.png');
    fs.writeFileSync(imagePath, ONE_PIXEL_PNG);
    const logs: string[] = [];

    const input = parseAppServerInput(
      `리뷰 증거\n[Image: settings-v0.1.92-deployed-390.png → ${imagePath}]`,
      (message) => logs.push(message),
    );

    expect(input).toEqual([
      { type: 'text', text: '리뷰 증거' },
      { type: 'localImage', path: imagePath },
    ]);
    expect(logs).toContain(`Adding image input: ${imagePath}`);
  });
});
