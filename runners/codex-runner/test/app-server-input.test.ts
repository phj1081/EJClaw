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
      {
        type: 'text',
        text: 'Image evidence: settings-v0.1.92-deployed-390.png',
      },
      { type: 'localImage', path: imagePath },
    ]);
    expect(logs).toContain(`Adding image input: ${imagePath}`);
  });

  it('keeps missing image evidence visible in Codex prompts', () => {
    const missingPath = path.join(
      os.tmpdir(),
      'ejclaw-missing-codex-image-evidence.png',
    );
    const logs: string[] = [];

    const input = parseAppServerInput(
      `리뷰 증거\n[Image: expected-render.png → ${missingPath}]`,
      (message) => logs.push(message),
    );

    expect(input).toEqual([
      { type: 'text', text: '리뷰 증거' },
      {
        type: 'text',
        text: `[Image unavailable: expected-render.png → ${missingPath} — file not found]`,
      },
    ]);
    expect(logs).toContain(`Image not found, skipping: ${missingPath}`);
  });

  it('keeps unsupported image evidence visible in Codex prompts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-codex-bmp-'));
    cleanupDirs.push(dir);
    const imagePath = path.join(dir, 'settings.bmp');
    fs.writeFileSync(imagePath, Buffer.from('BMunsupported'));
    const logs: string[] = [];

    const input = parseAppServerInput(
      `리뷰 증거\n[Image: settings.bmp → ${imagePath}]`,
      (message) => logs.push(message),
    );

    expect(input).toEqual([
      { type: 'text', text: '리뷰 증거' },
      {
        type: 'text',
        text: `[Image unavailable: settings.bmp → ${imagePath} — unsupported image type .bmp]`,
      },
    ]);
    expect(logs).toContain(`Unsupported image type, skipping: ${imagePath}`);
  });

  it('loads MEDIA image directives as local image input items', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-codex-media-'));
    cleanupDirs.push(dir);
    const imagePath = path.join(dir, 'media-render.png');
    fs.writeFileSync(imagePath, ONE_PIXEL_PNG);

    const input = parseAppServerInput(`증거\nMEDIA:${imagePath}`);

    expect(input).toEqual([
      { type: 'text', text: '증거' },
      { type: 'text', text: 'Image evidence: media-render.png' },
      { type: 'localImage', path: imagePath },
    ]);
  });

  it('loads markdown image links as local image input items', () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-codex-markdown-'),
    );
    cleanupDirs.push(dir);
    const imagePath = path.join(dir, 'markdown-render.png');
    fs.writeFileSync(imagePath, ONE_PIXEL_PNG);

    const input = parseAppServerInput(`증거 ![render](${imagePath})`);

    expect(input).toEqual([
      { type: 'text', text: '증거' },
      { type: 'text', text: 'Image evidence: markdown-render.png' },
      { type: 'localImage', path: imagePath },
    ]);
  });
});
