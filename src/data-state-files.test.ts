import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { listUnexpectedDataStateFiles } from './data-state-files.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-data-state-'));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe('listUnexpectedDataStateFiles', () => {
  it('allows known runtime state files', () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, 'token-rotation-state.json'), '{}');
    fs.writeFileSync(path.join(dataDir, 'codex-rotation-state.json'), '{}');
    fs.writeFileSync(path.join(dataDir, 'codex-warmup-state.json'), '{}');
    fs.writeFileSync(path.join(dataDir, 'claude-usage-cache.json'), '{}');
    fs.writeFileSync(path.join(dataDir, 'restart-context.abc.json'), '{}');

    expect(listUnexpectedDataStateFiles(dataDir)).toEqual([]);
  });

  it('reports unsupported legacy state files', () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, 'router_state.json'), '{}');

    expect(listUnexpectedDataStateFiles(dataDir)).toEqual([
      'router_state.json',
    ]);
  });
});
