import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  formatHostEvidenceResponse,
  normalizeHostEvidenceTailLines,
  resolveHostEvidenceResponsesDir,
  waitForHostEvidenceResponse,
} from '../src/host-evidence.js';

describe('runner host evidence helpers', () => {
  it('normalizes log tail lines for the MCP request', () => {
    expect(normalizeHostEvidenceTailLines(undefined)).toBe(20);
    expect(normalizeHostEvidenceTailLines(0)).toBe(1);
    expect(normalizeHostEvidenceTailLines(999)).toBe(200);
    expect(normalizeHostEvidenceTailLines(25)).toBe(25);
  });

  it('reads and removes the host evidence response file', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-host-ipc-'));
    const responseDir = resolveHostEvidenceResponsesDir(ipcDir);
    fs.mkdirSync(responseDir, { recursive: true });

    const responsePath = path.join(responseDir, 'req-1.json');
    fs.writeFileSync(
      responsePath,
      JSON.stringify({
        requestId: 'req-1',
        ok: true,
        action: 'ejclaw_service_status',
        command: 'systemctl --user show ejclaw',
        stdout: 'ActiveState=active\n',
        stderr: '',
        exitCode: 0,
      }),
    );

    const response = await waitForHostEvidenceResponse(responseDir, 'req-1', {
      timeoutMs: 100,
      pollMs: 10,
    });

    expect(response.ok).toBe(true);
    expect(response.stdout).toContain('ActiveState=active');
    expect(fs.existsSync(responsePath)).toBe(false);
  });

  it('formats the response into a compact MCP-friendly text block', () => {
    const text = formatHostEvidenceResponse({
      requestId: 'req-2',
      ok: false,
      action: 'ejclaw_service_logs',
      command: 'journalctl --user -u ejclaw --no-pager -n 10',
      stdout: 'line 1\nline 2\n',
      stderr: 'No journal files were found.\n',
      exitCode: 1,
      error: 'command failed',
    });

    expect(text).toContain('Host evidence action: ejclaw_service_logs');
    expect(text).toContain('Exit code: 1');
    expect(text).toContain('$ journalctl --user -u ejclaw --no-pager -n 10');
    expect(text).toContain('[stderr]');
    expect(text).toContain('[error] command failed');
  });
});
