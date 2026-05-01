import fs from 'fs';
import path from 'path';

import { CACHE_DIR } from './config.js';
import { readJsonFile, writeJsonFile } from './utils.js';
import type { GroupStatus } from './group-queue.js';
import type { AgentType } from './types.js';

export interface StatusSnapshotEntry {
  jid: string;
  name: string;
  folder: string;
  agentType: AgentType;
  status: GroupStatus['status'];
  elapsedMs: number | null;
  pendingMessages: boolean;
  pendingTasks: number;
}

export interface UsageRowSnapshot {
  name: string;
  h5pct: number;
  h5reset: string;
  d7pct: number;
  d7reset: string;
}

export interface StatusSnapshot {
  serviceId: string;
  agentType: AgentType;
  assistantName: string;
  updatedAt: string;
  entries: StatusSnapshotEntry[];
  usageRows?: UsageRowSnapshot[];
  /** ISO timestamp of the last successful usage data fetch (separate from updatedAt heartbeat). */
  usageRowsFetchedAt?: string;
}

const STATUS_SNAPSHOT_DIR = path.join(CACHE_DIR, 'status-dashboard');
const STATUS_MESSAGE_STATE_DIR = path.join(STATUS_SNAPSHOT_DIR, 'messages');

interface StatusMessageState {
  messageId: string;
  statusChannelId: string;
  updatedAt: string;
}

function sanitizeStatusChannelId(statusChannelId: string): string {
  return statusChannelId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getStatusMessageStatePath(statusChannelId: string): string {
  return path.join(
    STATUS_MESSAGE_STATE_DIR,
    `${sanitizeStatusChannelId(statusChannelId)}.json`,
  );
}

export function readDashboardStatusMessageId(
  statusChannelId: string,
): string | null {
  if (!statusChannelId) return null;
  const parsed = readJsonFile<StatusMessageState>(
    getStatusMessageStatePath(statusChannelId),
  );
  if (
    parsed?.statusChannelId !== statusChannelId ||
    typeof parsed.messageId !== 'string' ||
    parsed.messageId.trim() === ''
  ) {
    return null;
  }
  return parsed.messageId;
}

export function writeDashboardStatusMessageId(
  statusChannelId: string,
  messageId: string,
): void {
  if (!statusChannelId || !messageId) return;
  fs.mkdirSync(STATUS_MESSAGE_STATE_DIR, { recursive: true });
  const targetPath = getStatusMessageStatePath(statusChannelId);
  const tempPath = `${targetPath}.tmp`;
  writeJsonFile(
    tempPath,
    {
      messageId,
      statusChannelId,
      updatedAt: new Date().toISOString(),
    } satisfies StatusMessageState,
    true,
  );
  fs.renameSync(tempPath, targetPath);
}

export function writeStatusSnapshot(snapshot: StatusSnapshot): void {
  fs.mkdirSync(STATUS_SNAPSHOT_DIR, { recursive: true });
  const targetPath = path.join(
    STATUS_SNAPSHOT_DIR,
    `${snapshot.serviceId}.json`,
  );
  const tempPath = `${targetPath}.tmp`;
  writeJsonFile(tempPath, snapshot, true);
  fs.renameSync(tempPath, targetPath);
}

export function readStatusSnapshots(maxAgeMs: number): StatusSnapshot[] {
  if (!fs.existsSync(STATUS_SNAPSHOT_DIR)) return [];

  const now = Date.now();
  const snapshots: StatusSnapshot[] = [];

  for (const entry of fs.readdirSync(STATUS_SNAPSHOT_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const snapshotPath = path.join(STATUS_SNAPSHOT_DIR, entry);

    try {
      const raw = fs.readFileSync(snapshotPath, 'utf-8');
      const parsed = JSON.parse(raw) as StatusSnapshot;
      if (
        !parsed.updatedAt ||
        !parsed.serviceId ||
        !parsed.agentType ||
        !Array.isArray(parsed.entries)
      )
        continue;

      const ageMs = now - new Date(parsed.updatedAt).getTime();
      if (Number.isNaN(ageMs) || ageMs > maxAgeMs) continue;

      snapshots.push(parsed);
    } catch {
      continue;
    }
  }

  return snapshots;
}
