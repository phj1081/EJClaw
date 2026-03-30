import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execSyncMock, isRootMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  isRootMock: vi.fn(() => false),
}));

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('./platform.js', () => ({
  isRoot: isRootMock,
}));

import {
  checkLaunchdService,
  checkNohupService,
  checkSystemdService,
  getServiceChecks,
} from './verify-services.js';
import type { ServiceDef } from './service-defs.js';

describe('verify service checks', () => {
  afterEach(() => {
    execSyncMock.mockReset();
    isRootMock.mockReset();
    isRootMock.mockReturnValue(false);
    vi.restoreAllMocks();
  });

  it('treats launchd entries with a PID as running', () => {
    execSyncMock.mockReturnValue('123\t0\tcom.ejclaw\n');

    expect(checkLaunchdService('com.ejclaw')).toBe('running');
  });

  it('treats launchd entries without a PID as stopped', () => {
    execSyncMock.mockReturnValue('-\t0\tcom.ejclaw\n');

    expect(checkLaunchdService('com.ejclaw')).toBe('stopped');
  });

  it('checks systemd user services with the user prefix', () => {
    isRootMock.mockReturnValue(false);
    execSyncMock.mockReturnValue(undefined);

    expect(checkSystemdService('ejclaw')).toBe('running');
    expect(execSyncMock).toHaveBeenCalledWith('systemctl --user is-active ejclaw', {
      stdio: 'ignore',
    });
  });

  it('treats known but inactive systemd services as stopped', () => {
    execSyncMock
      .mockImplementationOnce(() => {
        throw new Error('inactive');
      })
      .mockReturnValueOnce('ejclaw.service enabled\n');

    expect(checkSystemdService('ejclaw')).toBe('stopped');
  });

  it('treats a live nohup PID as running', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-verify-'));
    const pidFile = path.join(tempRoot, 'ejclaw.pid');
    fs.writeFileSync(pidFile, '12345\n');

    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((_pid: number, _signal?: number | NodeJS.Signals) => true);

    expect(checkNohupService(tempRoot, 'ejclaw')).toBe('running');

    killSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('builds per-service status checks from service definitions', () => {
    const defs: ServiceDef[] = [
      {
        kind: 'primary',
        name: 'ejclaw',
        description: 'EJClaw',
        launchdLabel: 'com.ejclaw',
        logName: 'ejclaw',
      },
      {
        kind: 'codex',
        name: 'ejclaw-codex',
        description: 'Codex',
        launchdLabel: 'com.ejclaw.codex',
        logName: 'ejclaw-codex',
      },
    ];
    execSyncMock.mockReturnValue('123\t0\tcom.ejclaw\n');

    expect(getServiceChecks(defs, '/tmp/ejclaw', 'launchd')).toEqual([
      { name: 'ejclaw', status: 'running' },
      { name: 'ejclaw-codex', status: 'not_found' },
    ]);
  });
});
