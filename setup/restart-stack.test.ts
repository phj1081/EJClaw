import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STACK_RESTART_UNIT_NAME,
  restartStackServices,
} from './restart-stack.js';

describe('restartStackServices', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('dispatches stack restart through the oneshot unit by default', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-restart-'));
    tempRoots.push(tempRoot);

    const execFileSyncImpl = vi.fn();

    const services = restartStackServices(tempRoot, {
      execFileSyncImpl,
      runningAsRoot: false,
      serviceManager: 'systemd',
      serviceId: null,
    });

    expect(services).toEqual(['ejclaw']);
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      1,
      'systemctl',
      ['--user', 'start', '--wait', STACK_RESTART_UNIT_NAME],
      { stdio: 'ignore' },
    );
    expect(execFileSyncImpl).toHaveBeenCalledTimes(1);
  });

  it('restarts and verifies the unified service in direct mode', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-restart-'));
    tempRoots.push(tempRoot);

    const execFileSyncImpl = vi.fn();

    const services = restartStackServices(tempRoot, {
      direct: true,
      execFileSyncImpl,
      runningAsRoot: false,
      serviceManager: 'systemd',
      serviceId: null,
    });

    expect(services).toEqual(['ejclaw']);
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      1,
      'systemctl',
      ['--user', 'restart', 'ejclaw'],
      { stdio: 'ignore' },
    );
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      2,
      'systemctl',
      ['--user', 'is-active', '--quiet', 'ejclaw'],
      { stdio: 'ignore' },
    );
    expect(execFileSyncImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects non-systemd environments', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-restart-'));
    tempRoots.push(tempRoot);

    expect(() =>
      restartStackServices(tempRoot, {
        serviceManager: 'none',
      }),
    ).toThrow(
      'restart:stack only supports Linux systemd services in this repo',
    );
  });

  it('falls back to direct restart when the oneshot unit is not installed for an external caller', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-restart-'));
    tempRoots.push(tempRoot);

    const execFileSyncImpl = vi.fn().mockImplementationOnce(() => {
      const error = new Error('unit missing');
      Object.assign(error, {
        stderr: 'Unit ejclaw-stack-restart.service not found.',
      });
      throw error;
    });

    const services = restartStackServices(tempRoot, {
      execFileSyncImpl,
      runningAsRoot: false,
      serviceManager: 'systemd',
      serviceId: null,
    });

    expect(services).toEqual(['ejclaw']);
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      1,
      'systemctl',
      ['--user', 'start', '--wait', STACK_RESTART_UNIT_NAME],
      { stdio: 'ignore' },
    );
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      2,
      'systemctl',
      ['--user', 'restart', 'ejclaw'],
      { stdio: 'ignore' },
    );
  });

  it('rejects direct fallback when the unit is missing for a managed service caller', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-restart-'));
    tempRoots.push(tempRoot);

    const execFileSyncImpl = vi.fn().mockImplementation(() => {
      const error = new Error('unit missing');
      Object.assign(error, {
        stderr: 'Unit ejclaw-stack-restart.service not found.',
      });
      throw error;
    });

    expect(() =>
      restartStackServices(tempRoot, {
        execFileSyncImpl,
        runningAsRoot: false,
        serviceManager: 'systemd',
        serviceId: 'codex-main',
      }),
    ).toThrow('Run `bun run setup -- --step service`');
  });

  it('does not hide a general start failure behind direct fallback', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-restart-'));
    tempRoots.push(tempRoot);

    const execFileSyncImpl = vi.fn().mockImplementation(() => {
      const error = new Error('job failed');
      Object.assign(error, {
        stderr:
          'Job for ejclaw-stack-restart.service failed because the control process exited with error code.',
      });
      throw error;
    });

    expect(() =>
      restartStackServices(tempRoot, {
        execFileSyncImpl,
        runningAsRoot: false,
        serviceManager: 'systemd',
        serviceId: null,
      }),
    ).toThrow('job failed');
    expect(execFileSyncImpl).toHaveBeenCalledTimes(1);
  });
});
