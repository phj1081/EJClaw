import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

import {
  detectLegacyServiceIssues,
  formatLegacyServiceFailureMessage,
} from './legacy-service-guard.js';

describe('legacy service guard', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    execSyncMock.mockReset();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects legacy systemd units in the opposite scope', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-legacy-'));
    tempRoots.push(projectRoot);

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'systemctl is-active ejclaw-codex') {
        throw new Error('inactive');
      }
      if (cmd === 'systemctl list-unit-files') {
        return 'ejclaw-codex.service enabled\n';
      }
      if (cmd === 'systemctl --user is-active ejclaw-codex') {
        throw new Error('inactive');
      }
      if (cmd === 'systemctl --user list-unit-files') {
        return '';
      }
      if (cmd === 'systemctl is-active ejclaw-review') {
        throw new Error('inactive');
      }
      if (cmd === 'systemctl --user is-active ejclaw-review') {
        throw new Error('inactive');
      }
      if (cmd === 'systemctl list-unit-files' || cmd === 'systemctl --user list-unit-files') {
        return '';
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    expect(detectLegacyServiceIssues(projectRoot, 'systemd')).toEqual([
      {
        name: 'ejclaw-codex',
        status: 'stopped',
        sources: ['systemd-system'],
      },
    ]);
  });

  it('detects legacy nohup artifacts even on systemd hosts', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-legacy-'));
    tempRoots.push(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'start-ejclaw-codex.sh'), '#!/bin/bash\n');

    execSyncMock.mockImplementation((cmd: string) => {
      if (
        cmd === 'systemctl is-active ejclaw-codex' ||
        cmd === 'systemctl --user is-active ejclaw-codex' ||
        cmd === 'systemctl is-active ejclaw-review' ||
        cmd === 'systemctl --user is-active ejclaw-review'
      ) {
        throw new Error('inactive');
      }
      if (
        cmd === 'systemctl list-unit-files' ||
        cmd === 'systemctl --user list-unit-files'
      ) {
        return '';
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    expect(detectLegacyServiceIssues(projectRoot, 'systemd')).toEqual([
      {
        name: 'ejclaw-codex',
        status: 'stopped',
        sources: ['nohup'],
      },
    ]);
  });

  it('formats cleanup instructions for the detected scopes only', () => {
    const message = formatLegacyServiceFailureMessage({
      projectRoot: '/srv/ejclaw',
      serviceManager: 'systemd',
      homeDir: '/home/user',
      services: [
        {
          name: 'ejclaw-codex',
          status: 'stopped',
          sources: ['systemd-system', 'nohup'],
        },
        {
          name: 'ejclaw-review',
          status: 'running',
          sources: ['systemd-user'],
        },
      ],
    });

    expect(message).toContain('systemctl disable --now ejclaw-codex');
    expect(message).toContain('systemctl --user disable --now ejclaw-review');
    expect(message).toContain('pkill -F "/srv/ejclaw/ejclaw-codex.pid"');
    expect(message).not.toContain('systemctl --user disable --now ejclaw-codex');
  });
});
