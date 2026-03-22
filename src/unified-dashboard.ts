import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  STATUS_SHOW_ROOMS,
  USAGE_DASHBOARD_ENABLED,
} from './config.js';
import {
  fetchClaudeUsageViaCli,
  type ClaudeUsageData,
} from './claude-usage.js';
import {
  composeDashboardContent,
  formatElapsed,
  getStatusLabel as formatDashboardStatusLabel,
  type DashboardRoomLine,
  renderCategorizedRoomSections,
} from './dashboard-render.js';
import { getAllChats, updateRegisteredGroupName } from './db.js';
import { readEnvFile } from './env.js';
import type { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import {
  readStatusSnapshots,
  writeStatusSnapshot,
} from './status-dashboard.js';
import type {
  AgentType,
  Channel,
  ChannelMeta,
  RegisteredGroup,
} from './types.js';

export interface UnifiedDashboardOptions {
  assistantName: string;
  serviceAgentType: AgentType;
  statusChannelId: string;
  statusUpdateInterval: number;
  usageUpdateInterval: number;
  channels: Channel[];
  queue: GroupQueue;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onGroupNameSynced?: (jid: string, name: string) => void;
  purgeOnStart?: boolean;
}

interface CodexRateLimit {
  limitId?: string;
  limitName: string | null;
  primary: { usedPercent: number; resetsAt: string | number };
  secondary: { usedPercent: number; resetsAt: string | number };
}

const STATUS_ICONS: Record<string, string> = {
  processing: '🟡',
  waiting: '🔵',
  inactive: '⚪',
};

const CHANNEL_META_REFRESH_MS = 300000;
const STATUS_SNAPSHOT_MAX_AGE_MS = 60000;

let statusMessageId: string | null = null;
let cachedUsageContent = '';
let cachedClaudeUsageData: ClaudeUsageData | null = null;
let usageUpdateInProgress = false;
let usageApiBackoffUntil = 0;
let usageApi429Streak = 0;
let usageApiPollingDisabled = false;
let channelMetaCache = new Map<string, ChannelMeta>();
let channelMetaLastRefresh = 0;

function formatResetKST(value: string | number): string {
  try {
    const date =
      typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return date.toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(value);
  }
}

function findDiscordChannel(channels: Channel[]): Channel | undefined {
  return channels.find(
    (channel) => channel.name.startsWith('discord') && channel.isConnected(),
  );
}

async function purgeDashboardChannel(
  opts: Pick<UnifiedDashboardOptions, 'channels' | 'statusChannelId'>,
): Promise<void> {
  if (!opts.statusChannelId) return;

  const statusJid = `dc:${opts.statusChannelId}`;
  const channel = opts.channels.find(
    (item) =>
      item.name.startsWith('discord') &&
      item.isConnected() &&
      item.purgeChannel,
  );
  if (channel?.purgeChannel) {
    await channel.purgeChannel(statusJid);
  }
}

function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const absolute = Date.parse(retryAfter);
  if (!Number.isNaN(absolute)) {
    return Math.max(0, absolute - Date.now());
  }

  return null;
}

async function refreshChannelMeta(
  opts: UnifiedDashboardOptions,
): Promise<void> {
  const now = Date.now();
  if (now - channelMetaLastRefresh < CHANNEL_META_REFRESH_MS) return;

  const channel = opts.channels.find(
    (item) =>
      item.name.startsWith('discord') && item.isConnected() && item.getChannelMeta,
  );
  if (!channel?.getChannelMeta) return;

  const localJids = Object.keys(opts.registeredGroups()).filter((jid) =>
    jid.startsWith('dc:'),
  );
  const snapshotJids = readStatusSnapshots(STATUS_SNAPSHOT_MAX_AGE_MS)
    .flatMap((snapshot) => snapshot.entries.map((entry) => entry.jid))
    .filter((jid) => jid.startsWith('dc:'));
  const jids = [...new Set([...localJids, ...snapshotJids])];

  try {
    channelMetaCache = await channel.getChannelMeta(jids);
    channelMetaLastRefresh = now;

    for (const [jid, meta] of channelMetaCache) {
      if (!meta.name) continue;
      const group = opts.registeredGroups()[jid];
      if (!group || group.name === meta.name) continue;
      logger.info(
        { jid, oldName: group.name, newName: meta.name },
        'Syncing group name to Discord channel name',
      );
      updateRegisteredGroupName(jid, meta.name);
      opts.onGroupNameSynced?.(jid, meta.name);
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to refresh channel metadata');
  }
}

function getAgentDisplayName(agentType: 'claude-code' | 'codex'): string {
  return agentType === 'codex' ? '코덱스' : '클코';
}

function formatRoomName(
  jid: string,
  meta: ChannelMeta | undefined,
  fallbackName: string | undefined,
  chatName: string | undefined,
): string {
  const base =
    meta?.name ||
    (chatName && chatName !== jid ? chatName : undefined) ||
    (fallbackName && fallbackName !== jid ? fallbackName : undefined) ||
    jid;

  if (jid.startsWith('dc:') && base !== jid && !base.startsWith('#')) {
    return `#${base}`;
  }
  return base;
}

function writeLocalStatusSnapshot(opts: UnifiedDashboardOptions): void {
  const groups = opts.registeredGroups();
  const statuses = opts.queue.getStatuses(Object.keys(groups));

  writeStatusSnapshot({
    agentType: opts.serviceAgentType,
    assistantName: opts.assistantName,
    updatedAt: new Date().toISOString(),
    entries: statuses
      .map((status) => {
        const group = groups[status.jid];
        if (!group) return null;
        return {
          jid: status.jid,
          name: group.name,
          folder: group.folder,
          agentType: (group.agentType || opts.serviceAgentType) as
            | 'claude-code'
            | 'codex',
          status: status.status,
          elapsedMs: status.elapsedMs,
          pendingMessages: status.pendingMessages,
          pendingTasks: status.pendingTasks,
        };
      })
      .filter(Boolean) as Array<{
      jid: string;
      name: string;
      folder: string;
      agentType: 'claude-code' | 'codex';
      status: 'processing' | 'waiting' | 'inactive';
      elapsedMs: number | null;
      pendingMessages: boolean;
      pendingTasks: number;
    }>,
  });
}

function buildStatusContent(): string {
  if (!STATUS_SHOW_ROOMS) return '';

  const snapshots = readStatusSnapshots(STATUS_SNAPSHOT_MAX_AGE_MS);
  const chatNameByJid = new Map(
    getAllChats().map((chat) => [chat.jid, chat.name]),
  );

  interface RoomEntry {
    agentType: 'claude-code' | 'codex';
    status: 'processing' | 'waiting' | 'inactive';
    elapsedMs: number | null;
    pendingMessages: boolean;
    pendingTasks: number;
    name: string;
    meta: ChannelMeta | undefined;
  }

  const byJid = new Map<string, RoomEntry[]>();

  for (const snapshot of snapshots) {
    const agentType = snapshot.agentType as 'claude-code' | 'codex';
    for (const entry of snapshot.entries) {
      const existing = byJid.get(entry.jid) || [];
      existing.push({
        agentType,
        status: entry.status,
        elapsedMs: entry.elapsedMs,
        pendingMessages: entry.pendingMessages,
        pendingTasks: entry.pendingTasks,
        name: entry.name,
        meta: channelMetaCache.get(entry.jid),
      });
      byJid.set(entry.jid, existing);
    }
  }

  interface RoomInfo {
    name: string;
    meta: ChannelMeta | undefined;
    agents: RoomEntry[];
  }

  const categoryMap = new Map<string, RoomInfo[]>();
  let totalActive = 0;
  let totalRooms = 0;

  for (const [jid, agents] of byJid) {
    const meta = agents[0]?.meta;
    const category = meta?.category || '기타';
    if (!categoryMap.has(category)) {
      categoryMap.set(category, []);
    }
    categoryMap.get(category)!.push({
      name: formatRoomName(
        jid,
        meta,
        agents.find((agent) => agent.name && agent.name !== jid)?.name,
        chatNameByJid.get(jid),
      ),
      meta,
      agents,
    });
    totalRooms++;
    if (agents.some((agent) => agent.status === 'processing')) {
      totalActive++;
    }
  }

  const sortedCategories = [...categoryMap.entries()].sort((a, b) => {
    const posA = a[1][0]?.meta?.categoryPosition ?? 999;
    const posB = b[1][0]?.meta?.categoryPosition ?? 999;
    return posA - posB;
  });

  const roomLines: DashboardRoomLine[] = [];
  for (const [categoryName, rooms] of sortedCategories) {
    rooms.sort((a, b) => (a.meta?.position ?? 999) - (b.meta?.position ?? 999));
    for (const room of rooms) {
      room.agents.sort((a, b) =>
        a.agentType === b.agentType ? 0 : a.agentType === 'claude-code' ? -1 : 1,
      );
      const agentParts = room.agents.map((agent) => {
        const icon = STATUS_ICONS[agent.status] || '⚪';
        const label = formatDashboardStatusLabel({
          status: agent.status,
          elapsedMs: agent.elapsedMs,
          pendingTasks: agent.pendingTasks,
        });
        const tag = getAgentDisplayName(agent.agentType);
        return `${tag} ${icon} ${label}`;
      });
      roomLines.push({
        category: categoryName,
        categoryPosition: room.meta?.categoryPosition ?? 999,
        position: room.meta?.position ?? 999,
        line: `  **${room.name}** — ${agentParts.join(' | ')}`,
      });
    }
  }

  const header = `**📊 에이전트 상태** — 활성 ${totalActive} / ${totalRooms}`;
  const sections = renderCategorizedRoomSections({
    lines: roomLines,
    showCategoryHeaders: channelMetaCache.size > 0,
  });
  return `${header}\n\n${sections}`;
}

async function fetchClaudeUsage(): Promise<ClaudeUsageData | null> {
  if (usageApiPollingDisabled) {
    logger.debug('Skipping usage API call (polling disabled for this process)');
    return null;
  }
  if (Date.now() < usageApiBackoffUntil) {
    logger.debug('Skipping usage API call (backoff active)');
    return null;
  }

  const cliUsage = await fetchClaudeUsageViaCli();
  if (cliUsage) {
    usageApi429Streak = 0;
    return cliUsage;
  }

  try {
    const envToken = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']);
    let token =
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      envToken.CLAUDE_CODE_OAUTH_TOKEN ||
      '';
    if (!token) {
      const configDir =
        process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
      const credsPath = path.join(configDir, '.credentials.json');
      if (!fs.existsSync(credsPath)) return null;
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      token = creds?.claudeAiOauth?.accessToken || '';
    }
    if (!token) return null;

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const retryAfterMs = parseRetryAfterMs(retryAfter);
        const backoffMs = Math.max(600_000, retryAfterMs ?? 0);
        usageApi429Streak += 1;
        usageApiBackoffUntil = Date.now() + backoffMs;
        if (usageApi429Streak >= 3) {
          usageApiPollingDisabled = true;
        }
        logger.warn(
          {
            status: 429,
            retryAfter,
            retryAfterMs,
            backoffMs,
            consecutive429s: usageApi429Streak,
            pollingDisabled: usageApiPollingDisabled,
            body: body.slice(0, 200),
          },
          usageApiPollingDisabled
            ? 'Usage API rate limited repeatedly (429), disabling usage polling for this process'
            : 'Usage API rate limited (429), backing off',
        );
      } else {
        logger.warn(
          { status: res.status, body: body.slice(0, 200) },
          'Usage API returned non-OK status',
        );
      }
      return null;
    }
    usageApi429Streak = 0;
    return (await res.json()) as ClaudeUsageData;
  } catch (err) {
    logger.debug({ err }, 'Usage API fetch failed');
    return null;
  }
}

async function fetchCodexUsage(): Promise<CodexRateLimit[] | null> {
  const npmGlobalBin = path.join(os.homedir(), '.npm-global', 'bin', 'codex');
  const codexBin = fs.existsSync(npmGlobalBin) ? npmGlobalBin : 'codex';

  return new Promise((resolve) => {
    let done = false;
    let proc: ChildProcess | null = null;
    const finish = (value: CodexRateLimit[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (proc) {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), 20_000);

    try {
      proc = spawn(codexBin, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...(process.env as Record<string, string>),
          PATH: [
            path.dirname(process.execPath),
            path.join(os.homedir(), '.npm-global', 'bin'),
            process.env.PATH || '',
          ].join(':'),
        },
      });
    } catch {
      resolve(null);
      return;
    }

    if (!proc.stdout || !proc.stdin) {
      finish(null);
      return;
    }

    proc.on('error', () => finish(null));
    proc.on('close', () => finish(null));

    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            proc!.stdin!.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'account/rateLimits/read',
                params: {},
              }) + '\n',
            );
          } else if (message.id === 2 && message.result) {
            const byId = message.result.rateLimitsByLimitId;
            finish(
              byId && typeof byId === 'object'
                ? (Object.values(byId) as CodexRateLimit[])
                : null,
            );
          }
        } catch {
          /* ignore */
        }
      }
    });

    proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'usage-monitor', version: '1.0' } },
      }) + '\n',
    );
  });
}

async function buildUsageContent(): Promise<string> {
  const activeSnapshots = readStatusSnapshots(STATUS_SNAPSHOT_MAX_AGE_MS);
  const hasActiveClaudeWork = activeSnapshots.some(
    (snapshot) =>
      snapshot.agentType === 'claude-code' &&
      snapshot.entries.some(
        (entry) => entry.status === 'processing' || entry.status === 'waiting',
      ),
  );
  const shouldFetchClaudeUsage = USAGE_DASHBOARD_ENABLED;

  const [liveClaudeUsage, codexUsage] = await Promise.all([
    shouldFetchClaudeUsage && !hasActiveClaudeWork
      ? fetchClaudeUsage()
      : Promise.resolve(null),
    fetchCodexUsage(),
  ]);

  const claudeUsage = shouldFetchClaudeUsage
    ? liveClaudeUsage || cachedClaudeUsageData
    : null;
  const claudeUsageIsCached =
    shouldFetchClaudeUsage && !liveClaudeUsage && !!cachedClaudeUsageData;
  if (shouldFetchClaudeUsage && liveClaudeUsage) {
    cachedClaudeUsageData = liveClaudeUsage;
  }

  const lines: string[] = ['📊 *사용량*'];
  const bar = (pct: number) => {
    const filled = Math.round(pct / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  type UsageRow = {
    name: string;
    h5pct: number;
    h5reset: string;
    d7pct: number;
    d7reset: string;
  };
  const rows: UsageRow[] = [];

  if (claudeUsage) {
    const h5 = claudeUsage.five_hour;
    const d7 = claudeUsage.seven_day;
    rows.push({
      name: claudeUsageIsCached ? 'Claude*' : 'Claude',
      h5pct: h5
        ? h5.utilization > 1
          ? Math.round(h5.utilization)
          : Math.round(h5.utilization * 100)
        : -1,
      h5reset: h5 ? formatResetKST(h5.resets_at) : '',
      d7pct: d7
        ? d7.utilization > 1
          ? Math.round(d7.utilization)
          : Math.round(d7.utilization * 100)
        : -1,
      d7reset: d7 ? formatResetKST(d7.resets_at) : '',
    });
  }

  if (codexUsage && Array.isArray(codexUsage)) {
    const relevant = codexUsage.filter(
      (limit) =>
        limit.primary.usedPercent > 0 || limit.secondary.usedPercent > 0,
    );
    const display = relevant.length > 0 ? relevant : codexUsage.slice(0, 1);
    for (const limit of display) {
      rows.push({
        name: 'Codex',
        h5pct: Math.round(limit.primary.usedPercent),
        h5reset: formatResetKST(limit.primary.resetsAt),
        d7pct: Math.round(limit.secondary.usedPercent),
        d7reset: formatResetKST(limit.secondary.resetsAt),
      });
    }
  }

  if (rows.length > 0) {
    lines.push('```');
    lines.push('        5-Hour             7-Day');
    for (const row of rows) {
      const h5 =
        row.h5pct >= 0
          ? `${bar(row.h5pct)} ${String(row.h5pct).padStart(3)}%`
          : '  —  ';
      const d7 =
        row.d7pct >= 0
          ? `${bar(row.d7pct)} ${String(row.d7pct).padStart(3)}%`
          : '  —  ';
      lines.push(`${row.name.padEnd(8)}${h5}   ${d7}`);
    }
    lines.push('```');
  } else {
    lines.push('_조회 불가_');
  }

  if (shouldFetchClaudeUsage && usageApiPollingDisabled) {
    lines.push(
      '_* Claude 사용량 조회는 반복된 429로 이번 프로세스에서 일시 중지_',
    );
  }
  if (claudeUsageIsCached) {
    lines.push('_* Claude 사용량은 작업 중일 때는 캐시값 유지_');
  }
  lines.push('');
  lines.push('🖥️ *서버*');

  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuPct = Math.round((loadAvg[1] / cpuCount) * 100);
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const memPct = Math.round((usedMem / totalMem) * 100);
  const memUsedGB = (usedMem / 1073741824).toFixed(1);
  const memTotalGB = (totalMem / 1073741824).toFixed(1);

  let diskPct = 0;
  let diskUsedGB = '?';
  let diskTotalGB = '?';
  try {
    const df = execSync('df -B1 / | tail -1', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const parts = df.split(/\s+/);
    const diskUsed = parseInt(parts[2], 10);
    const diskTotal = parseInt(parts[1], 10);
    diskPct = Math.round((diskUsed / diskTotal) * 100);
    diskUsedGB = (diskUsed / 1073741824).toFixed(0);
    diskTotalGB = (diskTotal / 1073741824).toFixed(0);
  } catch {
    /* ignore */
  }

  lines.push('```');
  lines.push(`${'CPU'.padEnd(8)}${bar(cpuPct)} ${String(cpuPct).padStart(3)}%`);
  lines.push(
    `${'Memory'.padEnd(8)}${bar(memPct)} ${String(memPct).padStart(3)}%  ${memUsedGB}/${memTotalGB}GB`,
  );
  lines.push(
    `${'Disk'.padEnd(8)}${bar(diskPct)} ${String(diskPct).padStart(3)}%  ${diskUsedGB}/${diskTotalGB}GB`,
  );
  lines.push(`${'Uptime'.padEnd(8)}${formatElapsed(os.uptime() * 1000)}`);
  lines.push('```');

  return lines.join('\n');
}

function buildUnifiedDashboardContent(): string {
  const sections: string[] = [];
  if (STATUS_SHOW_ROOMS) {
    sections.push(buildStatusContent());
  }
  if (cachedUsageContent) {
    sections.push(cachedUsageContent);
  }
  return composeDashboardContent(sections);
}

async function refreshUsageCache(): Promise<void> {
  if (usageUpdateInProgress) return;
  usageUpdateInProgress = true;
  try {
    cachedUsageContent = await buildUsageContent();
  } catch {
    /* keep previous cache */
  } finally {
    usageUpdateInProgress = false;
  }
}

export async function startUnifiedDashboard(
  opts: UnifiedDashboardOptions,
): Promise<void> {
  if (!opts.statusChannelId) return;

  const isRenderer = opts.serviceAgentType === 'claude-code';
  const statusJid = `dc:${opts.statusChannelId}`;

  if (isRenderer && opts.purgeOnStart) {
    await purgeDashboardChannel(opts);
  }

  if (isRenderer) {
    await refreshUsageCache();
  }

  const updateStatus = async () => {
    writeLocalStatusSnapshot(opts);
    if (!isRenderer) return;

    const channel = findDiscordChannel(opts.channels);
    if (!channel) return;

    try {
      await refreshChannelMeta(opts);
      const content = buildUnifiedDashboardContent();
      if (!content) {
        statusMessageId = null;
        return;
      }

      if (statusMessageId && channel.editMessage) {
        await channel.editMessage(statusJid, statusMessageId, content);
      } else if (channel.sendAndTrack) {
        const id = await channel.sendAndTrack(statusJid, content);
        if (id) statusMessageId = id;
      }
    } catch (err) {
      logger.debug({ err }, 'Dashboard update failed');
      statusMessageId = null;
    }
  };

  setInterval(updateStatus, opts.statusUpdateInterval);
  await updateStatus();

  if (isRenderer) {
    setInterval(refreshUsageCache, opts.usageUpdateInterval);
  }

  logger.info(
    {
      channelId: opts.statusChannelId,
      isRenderer,
      agentType: opts.serviceAgentType,
    },
    isRenderer
      ? 'Unified dashboard started'
      : 'Status snapshot updater started',
  );
}
