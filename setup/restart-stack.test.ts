import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { restartStackServices } from './restart-stack.js';

describe('restartStackServices', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restarts and verifies the configured three-service stack', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-restart-'));
    tempRoots.push(tempRoot);
    fs.writeFileSync(path.join(tempRoot, '.env.codex'), 'A=1\n');
    fs.writeFileSync(path.join(tempRoot, '.env.codex-review'), 'B=1\n');

    const execFileSyncImpl = vi.fn();

    const services = restartStackServices(tempRoot, {
      execFileSyncImpl,
      runningAsRoot: false,
      serviceManager: 'systemd',
    });

    expect(services).toEqual(['ejclaw', 'ejclaw-codex', 'ejclaw-review']);
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      1,
      'systemctl',
      ['--user', 'restart', 'ejclaw', 'ejclaw-codex', 'ejclaw-review'],
      { stdio: 'ignore' },
    );
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      2,
      'systemctl',
      ['--user', 'is-active', '--quiet', 'ejclaw'],
      { stdio: 'ignore' },
    );
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      3,
      'systemctl',
      ['--user', 'is-active', '--quiet', 'ejclaw-codex'],
      { stdio: 'ignore' },
    );
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      4,
      'systemctl',
      ['--user', 'is-active', '--quiet', 'ejclaw-review'],
      { stdio: 'ignore' },
    );
  });

  it('rejects non-systemd environments', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-restart-'));
    tempRoots.push(tempRoot);

    expect(() =>
      restartStackServices(tempRoot, {
        serviceManager: 'nohup',
      }),
    ).toThrow('restart:stack only supports Linux systemd services in this repo');
  });
});
