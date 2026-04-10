import { describe, expect, it } from 'vitest';

import { isTaskScopedIpcDir, resolveIpcDirectories } from '../src/ipc-paths.js';

describe('ipc path helpers', () => {
  it('detects task-scoped IPC directories', () => {
    expect(isTaskScopedIpcDir('/data/ipc/group/tasks/task-123')).toBe(true);
    expect(isTaskScopedIpcDir('C:\\ipc\\group\\tasks\\task-123')).toBe(true);
    expect(isTaskScopedIpcDir('/data/ipc/group')).toBe(false);
  });

  it('fails fast when task-scoped IPC is missing host IPC dir', () => {
    expect(() =>
      resolveIpcDirectories({
        EJCLAW_IPC_DIR: '/data/ipc/group/tasks/task-123',
      }),
    ).toThrow(/EJCLAW_HOST_IPC_DIR is required/i);
  });

  it('allows group-scoped IPC to fall back to the local IPC dir', () => {
    expect(
      resolveIpcDirectories({
        EJCLAW_IPC_DIR: '/data/ipc/group',
      }),
    ).toEqual({
      ipcDir: '/data/ipc/group',
      hostIpcDir: '/data/ipc/group',
    });
  });

  it('keeps host and task IPC dirs distinct when both are provided', () => {
    expect(
      resolveIpcDirectories({
        EJCLAW_IPC_DIR: '/data/ipc/group/tasks/task-123',
        EJCLAW_HOST_IPC_DIR: '/data/ipc/group',
      }),
    ).toEqual({
      ipcDir: '/data/ipc/group/tasks/task-123',
      hostIpcDir: '/data/ipc/group',
    });
  });
});
