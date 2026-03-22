import path from 'path';

import { describe, expect, it } from 'vitest';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import {
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  resolveGroupSessionsPath,
  resolveTaskRuntimeIpcPath,
  resolveTaskSessionsPath,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved).toBe(path.resolve(GROUPS_DIR, 'family-chat'));
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(resolved).toBe(path.resolve(DATA_DIR, 'ipc', 'family-chat'));
  });

  it('resolves safe paths under data sessions directory', () => {
    const resolved = resolveGroupSessionsPath('family-chat');
    expect(resolved).toBe(path.resolve(DATA_DIR, 'sessions', 'family-chat'));
  });

  it('resolves task-scoped IPC and session paths under the group namespace', () => {
    expect(resolveTaskRuntimeIpcPath('family-chat', 'task-123')).toBe(
      path.resolve(DATA_DIR, 'ipc', 'family-chat', 'tasks', 'task-123'),
    );
    expect(resolveTaskSessionsPath('family-chat', 'task-123')).toBe(
      path.resolve(DATA_DIR, 'sessions', 'family-chat', 'tasks', 'task-123'),
    );
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
    expect(() =>
      resolveTaskRuntimeIpcPath('family-chat', '../../etc'),
    ).toThrow();
    expect(() => resolveTaskSessionsPath('family-chat', '/tmp')).toThrow();
  });
});
