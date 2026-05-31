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
        type: 'text',
        text: 'Image evidence: settings-v0.1.92-deployed-390.png',
      },
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

  it('keeps missing image evidence visible in Claude prompts', () => {
    const missingPath = path.join(
      os.tmpdir(),
      'ejclaw-missing-image-evidence.png',
    );
    const logs: string[] = [];

    const content = buildMultimodalContent(
      `리뷰 증거\n[Image: expected-render.png → ${missingPath}]`,
      (message) => logs.push(message),
    );

    expect(content).toEqual([
      { type: 'text', text: '리뷰 증거' },
      {
        type: 'text',
        text: `[Image unavailable: expected-render.png → ${missingPath} — file not found]`,
      },
    ]);
    expect(logs).toContain(`Image not found, skipping: ${missingPath}`);
  });

  it('keeps unsupported image evidence visible instead of mislabeled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-bmp-image-'));
    cleanupDirs.push(dir);
    const imagePath = path.join(dir, 'settings.bmp');
    fs.writeFileSync(imagePath, Buffer.from('BMunsupported'));
    const logs: string[] = [];

    const content = buildMultimodalContent(
      `리뷰 증거\n[Image: settings.bmp → ${imagePath}]`,
      (message) => logs.push(message),
    );

    expect(content).toEqual([
      { type: 'text', text: '리뷰 증거' },
      {
        type: 'text',
        text: `[Image unavailable: settings.bmp → ${imagePath} — unsupported image type .bmp]`,
      },
    ]);
    expect(logs).toContain(`Unsupported image type, skipping: ${imagePath}`);
  });

  it('loads MEDIA image directives as Claude image blocks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-media-image-'));
    cleanupDirs.push(dir);
    const imagePath = path.join(dir, 'media-render.png');
    fs.writeFileSync(imagePath, ONE_PIXEL_PNG);

    const content = buildMultimodalContent(`증거\nMEDIA:${imagePath}`, () => {
      // no-op
    });

    expect(content).toEqual([
      { type: 'text', text: '증거' },
      { type: 'text', text: 'Image evidence: media-render.png' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: ONE_PIXEL_PNG.toString('base64'),
        },
      },
    ]);
  });

  it('loads markdown image links as Claude image blocks', () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-markdown-image-'),
    );
    cleanupDirs.push(dir);
    const imagePath = path.join(dir, 'markdown-render.png');
    fs.writeFileSync(imagePath, ONE_PIXEL_PNG);

    const content = buildMultimodalContent(
      `증거 ![render](${imagePath})`,
      () => {
        // no-op
      },
    );

    expect(content).toEqual([
      { type: 'text', text: '증거' },
      { type: 'text', text: 'Image evidence: markdown-render.png' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: ONE_PIXEL_PNG.toString('base64'),
        },
      },
    ]);
  });
});
