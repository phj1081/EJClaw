import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateOutboundAttachments } from './outbound-attachments.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const MINIMAL_MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00,
  0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);
const MINIMAL_PDF = Buffer.from('%PDF-1.4\n', 'ascii');
const MINIMAL_ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

const cleanupDirs: string[] = [];
const cleanupFiles: string[] = [];

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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  for (const file of cleanupFiles.splice(0)) {
    fs.rmSync(file, { force: true });
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

  it('accepts direct EJClaw screenshot files under the temp directory', () => {
    const imagePath = path.join(
      os.tmpdir(),
      `ejclaw-room-mobile-list-${Date.now()}.png`,
    );
    fs.writeFileSync(imagePath, ONE_PIXEL_PNG);
    cleanupFiles.push(imagePath);

    const result = validateOutboundAttachments([
      {
        path: imagePath,
        name: 'room-list.png',
        mime: 'image/png',
      },
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.files).toEqual([
      {
        attachment: fs.realpathSync(imagePath),
        name: 'room-list.png',
      },
    ]);
  });

  it('accepts direct generated screenshot files under the temp directory', () => {
    const imagePath = path.join(
      os.tmpdir(),
      `bar-chart-label-fit-playwright-${Date.now()}.png`,
    );
    fs.writeFileSync(imagePath, ONE_PIXEL_PNG);
    cleanupFiles.push(imagePath);

    const result = validateOutboundAttachments([
      {
        path: imagePath,
        name: 'bar-chart-label-fit-playwright.png',
        mime: 'image/png',
      },
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.files).toEqual([
      {
        attachment: fs.realpathSync(imagePath),
        name: 'bar-chart-label-fit-playwright.png',
      },
    ]);
  });

  it('accepts generated image files in nested temp directories', () => {
    const dir = makeTempDir(os.tmpdir(), 'paladin-character-');
    const imagePath = writeFile(dir, 'sheet_12x.png', ONE_PIXEL_PNG);

    const result = validateOutboundAttachments([
      {
        path: imagePath,
        name: 'sheet_12x.png',
        mime: 'image/png',
      },
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.files).toEqual([
      {
        attachment: fs.realpathSync(imagePath),
        name: 'sheet_12x.png',
      },
    ]);
  });

  it('accepts supported non-image media and document files', () => {
    const dir = makeTempDir(os.tmpdir(), 'ejclaw-media-');
    const mp4Path = writeFile(dir, 'preview.mp4', MINIMAL_MP4);
    const pdfPath = writeFile(dir, 'report.pdf', MINIMAL_PDF);
    const zipPath = writeFile(dir, 'archive.zip', MINIMAL_ZIP);
    const textPath = writeFile(dir, 'notes.txt', 'hello\n');

    const result = validateOutboundAttachments([
      { path: mp4Path, mime: 'video/mp4' },
      { path: pdfPath, mime: 'application/pdf' },
      { path: zipPath, mime: 'application/zip' },
      { path: textPath, mime: 'text/plain' },
    ]);

    expect(result.rejected).toEqual([]);
    expect(result.files).toEqual([
      {
        attachment: fs.realpathSync(mp4Path),
        name: 'preview.mp4',
      },
      {
        attachment: fs.realpathSync(pdfPath),
        name: 'report.pdf',
      },
      {
        attachment: fs.realpathSync(zipPath),
        name: 'archive.zip',
      },
      {
        attachment: fs.realpathSync(textPath),
        name: 'notes.txt',
      },
    ]);
  });
});

describe('validateOutboundAttachments policy checks', () => {
  function useIsolatedDefaultTempDir(): void {
    const tempDir = makeTempDir(os.tmpdir(), 'ejclaw-policy-temp-');
    vi.spyOn(os, 'tmpdir').mockReturnValue(tempDir);
  }

  it('requires workspace paths to be explicitly allowlisted', () => {
    useIsolatedDefaultTempDir();
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

  it('accepts user-configured attachment directories from env', () => {
    const unusedCommaDir = makeTempDir(process.cwd(), '.ejclaw-unused-images-');
    const unusedDelimiterDir = makeTempDir(
      process.cwd(),
      '.ejclaw-more-unused-images-',
    );
    const dir = makeTempDir(process.cwd(), '.ejclaw-user-images-');
    const imagePath = writeFile(dir, 'manual-shot.png', ONE_PIXEL_PNG);
    vi.stubEnv(
      'EJCLAW_ATTACHMENT_ALLOWED_DIRS',
      `${unusedCommaDir},${unusedDelimiterDir}${path.delimiter}${dir}`,
    );

    const result = validateOutboundAttachments([{ path: imagePath }]);

    expect(result.rejected).toEqual([]);
    expect(result.files).toEqual([
      {
        attachment: fs.realpathSync(imagePath),
        name: 'manual-shot.png',
      },
    ]);
  });

  it('rejects symlink attempts that escape the allowed directory', () => {
    useIsolatedDefaultTempDir();
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

  it('rejects symlink attempts that escape a user-configured directory', () => {
    useIsolatedDefaultTempDir();
    const allowedDir = makeTempDir(process.cwd(), '.ejclaw-user-images-');
    const secretDir = makeTempDir(process.cwd(), '.ejclaw-secret-images-');
    const targetPath = writeFile(secretDir, 'secret-shot.png', ONE_PIXEL_PNG);
    const linkPath = path.join(allowedDir, 'linked-shot.png');
    fs.symlinkSync(targetPath, linkPath);
    vi.stubEnv('EJCLAW_ATTACHMENT_ALLOWED_DIRS', allowedDir);

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

  it('rejects supported non-image files with invalid signatures', () => {
    const dir = makeTempDir(os.tmpdir(), 'ejclaw-media-');
    const fakeMp4 = writeFile(dir, 'fake.mp4', 'not a movie');

    expect(validateOutboundAttachments([{ path: fakeMp4 }])).toEqual({
      files: [],
      rejected: [{ path: fakeMp4, reason: 'invalid-file-signature' }],
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
