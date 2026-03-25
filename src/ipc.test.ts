import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { claimIpcFile, quarantineClaimedIpcFiles } from './ipc.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-ipc-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ipc file claiming', () => {
  it('claims IPC files into a hidden processing directory before handling', () => {
    const baseDir = makeTempDir();
    const messagesDir = path.join(baseDir, 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });

    const filePath = path.join(messagesDir, 'message.json');
    fs.writeFileSync(filePath, '{"type":"message"}');

    const claimedPath = claimIpcFile(filePath);

    expect(claimedPath).toBe(
      path.join(messagesDir, '.processing', 'message.json'),
    );
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(claimedPath!)).toBe(true);
  });

  it('returns null when the IPC file was already claimed or deleted', () => {
    const baseDir = makeTempDir();
    const missingPath = path.join(baseDir, 'messages', 'missing.json');

    expect(claimIpcFile(missingPath)).toBeNull();
  });
});

describe('ipc claimed-file quarantine', () => {
  it('moves stranded claimed files into the error directory without reprocessing', () => {
    const baseDir = makeTempDir();
    const messagesDir = path.join(baseDir, 'messages');
    const processingDir = path.join(messagesDir, '.processing');
    const errorDir = path.join(baseDir, 'errors');

    fs.mkdirSync(processingDir, { recursive: true });
    fs.mkdirSync(errorDir, { recursive: true });

    const claimedPath = path.join(processingDir, 'message.json');
    fs.writeFileSync(claimedPath, '{"type":"message"}');

    const movedPaths = quarantineClaimedIpcFiles(
      messagesDir,
      errorDir,
      'group-message-stale',
    );

    expect(movedPaths).toHaveLength(1);
    expect(fs.existsSync(claimedPath)).toBe(false);
    expect(fs.existsSync(movedPaths[0])).toBe(true);
    expect(path.dirname(movedPaths[0])).toBe(errorDir);
  });
});
