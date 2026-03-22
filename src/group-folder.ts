import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RUNTIME_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function assertValidRuntimeSegment(segment: string, label: string): void {
  if (!segment || segment !== segment.trim()) {
    throw new Error(`Invalid ${label} "${segment}"`);
  }
  if (!RUNTIME_SEGMENT_PATTERN.test(segment)) {
    throw new Error(`Invalid ${label} "${segment}"`);
  }
  if (
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('..')
  ) {
    throw new Error(`Invalid ${label} "${segment}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

export function resolveGroupSessionsPath(folder: string): string {
  assertValidGroupFolder(folder);
  const sessionsBaseDir = path.resolve(DATA_DIR, 'sessions');
  const sessionsPath = path.resolve(sessionsBaseDir, folder);
  ensureWithinBase(sessionsBaseDir, sessionsPath);
  return sessionsPath;
}

export function resolveTaskRuntimeIpcPath(
  folder: string,
  taskId: string,
): string {
  assertValidGroupFolder(folder);
  assertValidRuntimeSegment(taskId, 'task ID');
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder, 'tasks', taskId);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

export function resolveTaskSessionsPath(
  folder: string,
  taskId: string,
): string {
  assertValidGroupFolder(folder);
  assertValidRuntimeSegment(taskId, 'task ID');
  const sessionsBaseDir = path.resolve(DATA_DIR, 'sessions');
  const sessionsPath = path.resolve(sessionsBaseDir, folder, 'tasks', taskId);
  ensureWithinBase(sessionsBaseDir, sessionsPath);
  return sessionsPath;
}
