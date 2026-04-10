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
  checkLaunchdServiceArtifact,
  checkNohupService,
  checkNohupServiceArtifact,
  checkSystemdService,
  checkSystemdServiceInScope,
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
    expect(execSyncMock).toHaveBeenCalledWith(
      'systemctl --user is-active ejclaw',
      {
        stdio: 'ignore',
      },
    );
  });

  it('checks systemd services in both explicit scopes', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === 'systemctl is-active ejclaw-codex') {
        return undefined;
      }
      if (cmd === 'systemctl --user is-active ejclaw-codex') {
        throw new Error('inactive');
      }
      if (cmd === 'systemctl --user list-unit-files') {
        return '';
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    expect(checkSystemdServiceInScope('ejclaw-codex', 'system')).toBe(
      'running',
    );
    expect(checkSystemdServiceInScope('ejclaw-codex', 'user')).toBe(
      'not_found',
    );
  });

  it('treats an unloaded launchd plist as stopped when artifact detection is enabled', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-launchd-'));
    const plistPath = path.join(
      tempHome,
      'Library',
      'LaunchAgents',
      'com.ejclaw-codex.plist',
    );
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, '<plist />');
    execSyncMock.mockReturnValue('');

    expect(checkLaunchdServiceArtifact('com.ejclaw-codex', plistPath)).toBe(
      'stopped',
    );

    fs.rmSync(tempHome, { recursive: true, force: true });
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
      .mockImplementation((_pid: number, _signal?: string | number) => true);

    expect(checkNohupService(tempRoot, 'ejclaw')).toBe('running');

    killSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('treats a legacy nohup wrapper without a live pid as stopped when artifact detection is enabled', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-verify-'));
    fs.writeFileSync(
      path.join(tempRoot, 'start-ejclaw-codex.sh'),
      '#!/bin/bash\n',
    );

    expect(checkNohupServiceArtifact(tempRoot, 'ejclaw-codex')).toBe('stopped');

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
        kind: 'primary',
        name: 'ejclaw-secondary',
        description: 'Secondary',
        launchdLabel: 'com.ejclaw.secondary',
        logName: 'ejclaw-secondary',
      },
    ];
    execSyncMock.mockReturnValue('123\t0\tcom.ejclaw\n');

    expect(getServiceChecks(defs, '/tmp/ejclaw', 'launchd')).toEqual([
      { name: 'ejclaw', status: 'running' },
      { name: 'ejclaw-secondary', status: 'not_found' },
    ]);
  });
});
