import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import type { PairedRoomRole } from './types.js';

export interface CompactRefreshFlag {
  sessionFolder: string;
  sessionId: string;
  compactedAt: string;
  trigger?: string | null;
}

export interface AppliedCompactRefresh {
  flag: CompactRefreshFlag;
  prompt: string;
}

const COMPACT_REFRESH_DIR = path.join(DATA_DIR, 'compact-refresh');

const COMPACT_REFRESH_PROMPT = `[EJClaw compact refresh]
The previous run compacted this same SDK session. Continue following the current AGENTS.md/CLAUDE.md role rules exactly: required first-line status, paired-room role boundaries, output-only task context, concise Korean responses, and verification before completion. This is not new user scope.
[/EJClaw compact refresh]`;

function getFlagPath(sessionFolder: string): string {
  return path.join(
    COMPACT_REFRESH_DIR,
    `${encodeURIComponent(sessionFolder)}.json`,
  );
}

function isRefreshableRole(role: PairedRoomRole): boolean {
  return role === 'owner' || role === 'reviewer';
}

function isSessionCommand(prompt: string): boolean {
  return prompt.trim() === '/compact';
}

export function readCompactRefreshFlag(
  sessionFolder: string,
): CompactRefreshFlag | null {
  const flagPath = getFlagPath(sessionFolder);
  if (!fs.existsSync(flagPath)) return null;

  try {
    const parsed = JSON.parse(
      fs.readFileSync(flagPath, 'utf-8'),
    ) as Partial<CompactRefreshFlag>;
    if (
      parsed.sessionFolder !== sessionFolder ||
      typeof parsed.sessionId !== 'string' ||
      parsed.sessionId.length === 0 ||
      typeof parsed.compactedAt !== 'string'
    ) {
      fs.rmSync(flagPath, { force: true });
      return null;
    }
    return {
      sessionFolder,
      sessionId: parsed.sessionId,
      compactedAt: parsed.compactedAt,
      trigger:
        typeof parsed.trigger === 'string' && parsed.trigger.length > 0
          ? parsed.trigger
          : null,
    };
  } catch {
    fs.rmSync(flagPath, { force: true });
    return null;
  }
}

export function markCompactRefreshNeeded(args: {
  sessionFolder: string;
  sessionId: string;
  trigger?: string | null;
}): CompactRefreshFlag {
  const flag: CompactRefreshFlag = {
    sessionFolder: args.sessionFolder,
    sessionId: args.sessionId,
    compactedAt: new Date().toISOString(),
    trigger: args.trigger ?? null,
  };
  fs.mkdirSync(COMPACT_REFRESH_DIR, { recursive: true });
  fs.writeFileSync(
    getFlagPath(args.sessionFolder),
    `${JSON.stringify(flag)}\n`,
  );
  return flag;
}

export function clearCompactRefreshIfUnchanged(args: {
  sessionFolder: string;
  flag: CompactRefreshFlag;
}): void {
  const current = readCompactRefreshFlag(args.sessionFolder);
  if (
    current &&
    current.sessionId === args.flag.sessionId &&
    current.compactedAt === args.flag.compactedAt
  ) {
    fs.rmSync(getFlagPath(args.sessionFolder), { force: true });
  }
}

export function maybeApplyCompactRefresh(args: {
  sessionFolder: string;
  sessionId?: string;
  role: PairedRoomRole;
  prompt: string;
}): AppliedCompactRefresh | null {
  if (!args.sessionId) return null;
  if (!isRefreshableRole(args.role)) return null;
  if (isSessionCommand(args.prompt)) return null;

  const flag = readCompactRefreshFlag(args.sessionFolder);
  if (!flag) return null;
  if (flag.sessionId !== args.sessionId) {
    fs.rmSync(getFlagPath(args.sessionFolder), { force: true });
    return null;
  }

  return {
    flag,
    prompt: `${COMPACT_REFRESH_PROMPT}\n\n${args.prompt}`,
  };
}
