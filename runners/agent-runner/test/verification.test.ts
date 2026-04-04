import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  computeVerificationSnapshotId,
  formatVerificationResponse,
  resolveVerificationResponsesDir,
  waitForVerificationResponse,
} from '../src/verification.js';

describe('runner verification helpers', () => {
  it('computes the same snapshot when excluded files change', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-runner-snapshot-'));
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=1\n');

    const first = computeVerificationSnapshotId(repoDir);
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=2\n');
    const second = computeVerificationSnapshotId(repoDir);

    expect(second).toBe(first);
  });

  it('reads and removes the verification response file', async () => {
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-verification-ipc-'),
    );
    const responseDir = resolveVerificationResponsesDir(ipcDir);
    fs.mkdirSync(responseDir, { recursive: true });

    const responsePath = path.join(responseDir, 'req-1.json');
    fs.writeFileSync(
      responsePath,
      JSON.stringify({
        requestId: 'req-1',
        ok: true,
        profile: 'typecheck',
        command: 'npm run typecheck',
        stdout: '',
        stderr: '',
        exitCode: 0,
        snapshotId: 'fs:abc123',
        runtimeVersion: 'ejclaw-reviewer:latest@sha256:test',
      }),
    );

    const response = await waitForVerificationResponse(responseDir, 'req-1', {
      timeoutMs: 100,
      pollMs: 10,
    });

    expect(response.ok).toBe(true);
    expect(response.snapshotId).toBe('fs:abc123');
    expect(fs.existsSync(responsePath)).toBe(false);
  });

  it('formats the response into a compact MCP-friendly text block', () => {
    const text = formatVerificationResponse({
      requestId: 'req-2',
      ok: false,
      profile: 'build',
      command: 'npm run build',
      stdout: 'tsc output\n',
      stderr: 'build failed\n',
      exitCode: 1,
      snapshotId: 'fs:def456',
      runtimeVersion: 'ejclaw-reviewer:latest@sha256:test',
      error: 'command failed',
    });

    expect(text).toContain('Verification profile: build');
    expect(text).toContain('Snapshot: fs:def456');
    expect(text).toContain('Runtime: ejclaw-reviewer:latest@sha256:test');
    expect(text).toContain('Exit code: 1');
    expect(text).toContain('$ npm run build');
    expect(text).toContain('[stderr]');
    expect(text).toContain('[error] command failed');
  });
});
