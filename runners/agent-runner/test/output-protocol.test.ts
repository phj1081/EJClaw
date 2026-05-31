import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildMultimodalContent } from '../src/output-protocol.js';

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

describe('agent-runner multimodal prompts', () => {
  it('loads labeled image tags as Claude image blocks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-image-tag-'));
    cleanupDirs.push(dir);
    const imagePath = path.join(dir, 'settings-v0.1.92-deployed-390.png');
    fs.writeFileSync(imagePath, ONE_PIXEL_PNG);
    const logs: string[] = [];

    const content = buildMultimodalContent(
      `리뷰 증거\n[Image: settings-v0.1.92-deployed-390.png → ${imagePath}]`,
      (message) => logs.push(message),
    );

    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([
      { type: 'text', text: '리뷰 증거' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: ONE_PIXEL_PNG.toString('base64'),
        },
      },
    ]);
    expect(logs).toContain(`Added image block: ${imagePath} (image/png)`);
  });
});
