import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateOutboundAttachments } from './outbound-attachments.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const cleanupDirs: string[] = [];

function makeTempDir(baseDir: string, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(baseDir, prefix));
  cleanupDirs.push(dir);
  return dir;
}

function writeFile(
  dir: string,
  name: string,
  content: Buffer | string,
): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe('validateOutboundAttachments', () => {
  it('accepts real image files under default attachment directories', () => {
    const dir = makeTempDir(os.tmpdir(), 'ejclaw-attachment-');
    const imagePath = writeFile(dir, 'screenshot.png', ONE_PIXEL_PNG);

    const result = validateOutboundAttachments([
      {
        path: imagePath,
        name: '../unsafe-name.png',
        mime: 'image/png',
      },
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.files).toEqual([
      {
        attachment: fs.realpathSync(imagePath),
        name: 'unsafe-name.png',
      },
    ]);
  });

  it('requires workspace paths to be explicitly allowlisted', () => {
    const dir = makeTempDir(process.cwd(), '.ejclaw-attachment-');
    const imagePath = writeFile(dir, 'workspace-shot.png', ONE_PIXEL_PNG);

    expect(validateOutboundAttachments([{ path: imagePath }])).toEqual({
      files: [],
      rejected: [{ path: imagePath, reason: 'outside-allowed-dirs' }],
    });

    const allowed = validateOutboundAttachments([{ path: imagePath }], {
      baseDirs: [dir],
    });

    expect(allowed.rejected).toEqual([]);
    expect(allowed.files).toEqual([
      {
        attachment: fs.realpathSync(imagePath),
        name: 'workspace-shot.png',
      },
    ]);
  });

  it('rejects symlink attempts that escape the allowed directory', () => {
    const workspaceDir = makeTempDir(process.cwd(), '.ejclaw-attachment-');
    const targetPath = writeFile(
      workspaceDir,
      'secret-shot.png',
      ONE_PIXEL_PNG,
    );
    const tmpDir = makeTempDir(os.tmpdir(), 'ejclaw-attachment-');
    const linkPath = path.join(tmpDir, 'linked-shot.png');
    fs.symlinkSync(targetPath, linkPath);

    const result = validateOutboundAttachments([{ path: linkPath }]);

    expect(result.files).toEqual([]);
    expect(result.rejected).toEqual([
      { path: linkPath, reason: 'outside-allowed-dirs' },
    ]);
  });

  it('rejects SVG attachments before inspecting file content', () => {
    const dir = makeTempDir(os.tmpdir(), 'ejclaw-attachment-');
    const svgPath = writeFile(dir, 'vector.svg', '<svg></svg>');

    const result = validateOutboundAttachments([{ path: svgPath }]);

    expect(result.files).toEqual([]);
    expect(result.rejected).toEqual([
      { path: svgPath, reason: 'unsupported-extension' },
    ]);
  });

  it('rejects files whose extension and image signature do not match policy', () => {
    const dir = makeTempDir(os.tmpdir(), 'ejclaw-attachment-');
    const fakePng = writeFile(dir, 'fake.png', 'not an image');
    const realPng = writeFile(dir, 'real.png', ONE_PIXEL_PNG);

    expect(validateOutboundAttachments([{ path: fakePng }])).toEqual({
      files: [],
      rejected: [{ path: fakePng, reason: 'invalid-image-signature' }],
    });
    expect(
      validateOutboundAttachments([{ path: realPng, mime: 'image/jpeg' }]),
    ).toEqual({
      files: [],
      rejected: [{ path: realPng, reason: 'mime-mismatch' }],
    });
  });

  it('rejects non-files and files over the size cap', () => {
    const dir = makeTempDir(os.tmpdir(), 'ejclaw-attachment-');
    const nestedDir = path.join(dir, 'nested.png');
    fs.mkdirSync(nestedDir);
    const largePng = writeFile(
      dir,
      'large.png',
      Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(8 * 1024 * 1024)]),
    );

    expect(validateOutboundAttachments([{ path: nestedDir }])).toEqual({
      files: [],
      rejected: [{ path: nestedDir, reason: 'not-file' }],
    });
    expect(validateOutboundAttachments([{ path: largePng }])).toEqual({
      files: [],
      rejected: [{ path: largePng, reason: 'too-large' }],
    });
  });
});
