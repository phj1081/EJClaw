import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  computeVerificationSnapshotId,
  formatVerificationResponse,
} from '../src/verification.js';

describe('runner verification helpers', () => {
  it('computes the same snapshot when excluded files change', () => {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ejclaw-runner-snapshot-'),
    );
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'src', 'index.ts'),
      'export const x = 1;\n',
    );
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=1\n');

    const first = computeVerificationSnapshotId(repoDir);
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=2\n');
    const second = computeVerificationSnapshotId(repoDir);

    expect(second).toBe(first);
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
      runtimeVersion: 'host:bun@test',
      error: 'command failed',
    });

    expect(text).toContain('Verification profile: build');
    expect(text).toContain('Snapshot: fs:def456');
    expect(text).toContain('Runtime: host:bun@test');
    expect(text).toContain('Exit code: 1');
    expect(text).toContain('$ npm run build');
    expect(text).toContain('[stderr]');
    expect(text).toContain('[error] command failed');
  });
});
