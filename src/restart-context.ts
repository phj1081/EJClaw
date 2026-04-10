import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, SERVICE_ID, TIMEZONE } from './config.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';
import { readJsonFile, writeJsonFile } from './utils.js';

export interface RestartInterruptedGroup {
  chatJid: string;
  groupName: string;
  status: 'processing' | 'idle' | 'waiting';
  elapsedMs: number | null;
  pendingMessages: boolean;
  pendingTasks: number;
}

export interface RestartContext {
  chatJid: string;
  summary: string;
  verify: string[];
  writtenAt: string;
  source?: 'explicit' | 'shutdown-snapshot';
  signal?: string;
  interruptedGroups?: RestartInterruptedGroup[];
}

export interface InferredRestartContext {
  chatJid: string;
  lines: string[];
}

export interface RestartRecoveryCandidate {
  chatJid: string;
  groupFolder: string;
  status: RestartInterruptedGroup['status'];
  pendingMessages: boolean;
  pendingTasks: number;
}

const INFER_WINDOW_MS = 3 * 60 * 1000;

function getRestartContextPath(serviceId: string = SERVICE_ID): string {
  return path.join(DATA_DIR, `restart-context.${serviceId}.json`);
}

function formatKoreanTimestamp(timestamp: string | number | Date): string {
  return new Date(timestamp).toLocaleString('ko-KR', {
    timeZone: TIMEZONE,
    hour12: false,
  });
}

function getMainGroupJid(
  roomBindings: Record<string, RegisteredGroup>,
): string | null {
  const mainEntry = Object.entries(roomBindings).find(
    ([, group]) => group.isMain === true,
  );
  return mainEntry?.[0] ?? null;
}

function readRestartContextFile(filePath: string): RestartContext | null {
  const data = readJsonFile<RestartContext>(filePath);
  if (data === null && fs.existsSync(filePath)) {
    logger.warn(
      { filePath },
      'Failed to parse restart context file; ignoring invalid content',
    );
  }
  return data;
}

function getLatestDistBuildTime(): number | null {
  const distDir = path.join(process.cwd(), 'dist');
  if (!fs.existsSync(distDir)) return null;

  let latestMtime = 0;
  for (const entry of fs.readdirSync(distDir)) {
    if (!entry.endsWith('.js')) continue;
    const stat = fs.statSync(path.join(distDir, entry));
    latestMtime = Math.max(latestMtime, stat.mtimeMs);
  }
  return latestMtime > 0 ? latestMtime : null;
}

function getRecentCommit(processStartedAtMs: number): string | null {
  try {
    const sinceSeconds = Math.max(
      60,
      Math.ceil(INFER_WINDOW_MS / 1000) + 30,
    ).toString();
    const output = execSync(
      `git log --since='${sinceSeconds} seconds ago' -1 --format=%h%x20%s`,
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      },
    ).trim();
    if (!output) return null;

    const commitTime = execSync('git log -1 --format=%ct', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    const commitTimeMs = Number(commitTime) * 1000;
    if (
      Number.isFinite(commitTimeMs) &&
      commitTimeMs >= processStartedAtMs - INFER_WINDOW_MS
    ) {
      return output;
    }
  } catch {
    // Ignore git inference failures on deployed environments without .git.
  }
  return null;
}

export function writeRestartContext(
  context: Omit<RestartContext, 'writtenAt'>,
  serviceIds: string[] = [SERVICE_ID],
): string[] {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload: RestartContext = {
    ...context,
    verify: context.verify,
    writtenAt: new Date().toISOString(),
  };

  const writtenPaths: string[] = [];
  for (const serviceId of serviceIds) {
    const filePath = getRestartContextPath(serviceId);
    writeJsonFile(filePath, payload, true);
    writtenPaths.push(filePath);
  }
  return writtenPaths;
}

export function writeShutdownRestartContext(
  roomBindings: Record<string, RegisteredGroup>,
  interruptedGroups: RestartInterruptedGroup[],
  signal: string,
  serviceIds: string[] = [SERVICE_ID],
): string[] {
  if (interruptedGroups.length === 0) return [];

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const mainChatJid =
    getMainGroupJid(roomBindings) ?? interruptedGroups[0].chatJid;
  const writtenPaths: string[] = [];

  for (const serviceId of serviceIds) {
    const filePath = getRestartContextPath(serviceId);
    const existing = readRestartContextFile(filePath);
    const mergedInterrupted = [
      ...(existing?.interruptedGroups ?? []),
      ...interruptedGroups,
    ].filter(
      (group, index, all) =>
        all.findIndex((candidate) => candidate.chatJid === group.chatJid) ===
        index,
    );

    const payload: RestartContext = {
      chatJid: existing?.chatJid || mainChatJid,
      summary: existing?.summary || '서비스 재시작으로 진행 중인 작업이 중단됨',
      verify: existing?.verify ?? [],
      writtenAt: new Date().toISOString(),
      source: existing?.source || 'shutdown-snapshot',
      signal,
      interruptedGroups: mergedInterrupted,
    };

    writeJsonFile(filePath, payload, true);
    writtenPaths.push(filePath);
  }

  return writtenPaths;
}

export function buildInterruptedRestartAnnouncement(
  interrupted: RestartInterruptedGroup,
): string {
  const lines = ['서비스 재시작으로 이전 작업이 중단됐습니다.'];
  lines.push(`- 직전 상태: ${interrupted.status}`);
  if (interrupted.elapsedMs !== null) {
    lines.push(
      `- 직전 실행 시간: ${Math.round(interrupted.elapsedMs / 1000)}초`,
    );
  }
  if (interrupted.pendingMessages) {
    lines.push('- 미처리 메시지가 남아 있었음');
  }
  if (interrupted.pendingTasks > 0) {
    lines.push(`- 대기 태스크: ${interrupted.pendingTasks}개`);
  }
  lines.push('- 필요하면 이어서 요청해 주세요.');
  return lines.join('\n');
}

export function consumeRestartContext(): RestartContext | null {
  const filePath = getRestartContextPath();
  if (!fs.existsSync(filePath)) return null;
  const parsed = readJsonFile<RestartContext>(filePath);
  if (!parsed) {
    logger.warn(
      { filePath },
      'Failed to read restart context; removing invalid file',
    );
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup failure.
  }
  return parsed;
}

export function buildRestartAnnouncement(context: RestartContext): string {
  const lines = ['재시작 완료.', `- 변경: ${context.summary}`];
  if (context.interruptedGroups && context.interruptedGroups.length > 0) {
    lines.push(`- 중단 작업 감지: ${context.interruptedGroups.length}개`);
  }
  if (context.verify.length > 0) {
    lines.push(`- 검증: ${context.verify.join(', ')}`);
  }
  lines.push(`- 기록 시각: ${formatKoreanTimestamp(context.writtenAt)}`);
  return lines.join('\n');
}

export function getInterruptedRecoveryCandidates(
  context: RestartContext | null,
  roomBindings: Record<string, RegisteredGroup>,
): RestartRecoveryCandidate[] {
  if (!context?.interruptedGroups?.length) return [];

  const seen = new Set<string>();
  const candidates: RestartRecoveryCandidate[] = [];

  for (const interrupted of context.interruptedGroups) {
    if (seen.has(interrupted.chatJid)) continue;
    const group = roomBindings[interrupted.chatJid];
    if (!group) continue;
    seen.add(interrupted.chatJid);
    candidates.push({
      chatJid: interrupted.chatJid,
      groupFolder: group.folder,
      status: interrupted.status,
      pendingMessages: interrupted.pendingMessages,
      pendingTasks: interrupted.pendingTasks,
    });
  }

  return candidates;
}

export function inferRecentRestartContext(
  roomBindings: Record<string, RegisteredGroup>,
  processStartedAtMs: number,
): InferredRestartContext | null {
  const chatJid = getMainGroupJid(roomBindings);
  if (!chatJid) return null;

  const latestBuildTime = getLatestDistBuildTime();
  const recentCommit = getRecentCommit(processStartedAtMs);
  const buildLooksRecent =
    latestBuildTime !== null &&
    latestBuildTime >= processStartedAtMs - INFER_WINDOW_MS;

  if (!buildLooksRecent && !recentCommit) return null;

  const lines = ['재시작 감지.', '- 명시적 재시작 힌트는 없어 추론 기반임.'];
  if (recentCommit) {
    lines.push(`- 최근 커밋: ${recentCommit}`);
  }
  if (latestBuildTime !== null) {
    lines.push(`- 최근 빌드: ${formatKoreanTimestamp(latestBuildTime)}`);
  }
  lines.push(`- 시작 시각: ${formatKoreanTimestamp(processStartedAtMs)}`);

  return { chatJid, lines };
}
