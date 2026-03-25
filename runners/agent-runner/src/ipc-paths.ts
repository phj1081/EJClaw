import path from 'path';

export interface ResolvedIpcDirectories {
  ipcDir: string;
  hostIpcDir: string;
}

export function isTaskScopedIpcDir(ipcDir: string): boolean {
  const normalized = path.posix.normalize(ipcDir.replaceAll('\\', '/'));
  return /\/tasks\/[^/]+\/?$/.test(normalized);
}

export function resolveIpcDirectories(
  env: NodeJS.ProcessEnv,
): ResolvedIpcDirectories {
  const ipcDir = env.EJCLAW_IPC_DIR || '/workspace/ipc';
  const hostIpcDir = env.EJCLAW_HOST_IPC_DIR;

  if (!hostIpcDir && isTaskScopedIpcDir(ipcDir)) {
    throw new Error(
      'EJCLAW_HOST_IPC_DIR is required for task-scoped IPC runtimes',
    );
  }

  return {
    ipcDir,
    hostIpcDir: hostIpcDir || ipcDir,
  };
}
