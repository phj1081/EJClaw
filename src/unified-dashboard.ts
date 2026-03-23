import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { STATUS_SHOW_ROOMS, USAGE_DASHBOARD_ENABLED } from './config.js';
import {
  fetchAllClaudeUsage,
  fetchAllClaudeProfiles,
  getClaudeProfile,
  type ClaudeAccountUsage,
} from './claude-usage.js';
import {
  getAllCodexAccounts,
  updateCodexAccountUsage,
} from './codex-token-rotation.js';
import {
  composeDashboardContent,
  formatElapsed,
  getStatusLabel as formatDashboardStatusLabel,
  type DashboardRoomLine,
  renderCategorizedRoomSections,
} from './dashboard-render.js';
import { getAllChats, updateRegisteredGroupName } from './db.js';
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
let cachedClaudeAccounts: ClaudeAccountUsage[] = [];
let usageUpdateInProgress = false;
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

function formatResetRemaining(value: string | number): string {
  try {
    const date =
      typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    const diffMs = date.getTime() - Date.now();
    if (diffMs <= 0) return ' reset';
    const hours = Math.floor(diffMs / 3_600_000);
    const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remH = hours % 24;
      return `${String(days).padStart(2)}d ${String(remH).padStart(2)}h`;
    }
    return `${String(hours).padStart(2)}h ${String(minutes).padStart(2)}m`;
  } catch {
    return String(value).padStart(6);
  }
}

function findDiscordChannel(channels: Channel[]): Channel | undefined {
  return channels.find(
    (channel) => channel.name.startsWith('discord') && channel.isConnected(),
  );
}

export async function purgeDashboardChannel(
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

async function refreshChannelMeta(
  opts: UnifiedDashboardOptions,
): Promise<void> {
  const now = Date.now();
  if (now - channelMetaLastRefresh < CHANNEL_META_REFRESH_MS) return;

  const channel = opts.channels.find(
    (item) =>
      item.name.startsWith('discord') &&
      item.isConnected() &&
      item.getChannelMeta,
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
        a.agentType === b.agentType
          ? 0
          : a.agentType === 'claude-code'
            ? -1
            : 1,
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

async function fetchCodexUsage(
  codexHomeOverride?: string,
): Promise<CodexRateLimit[] | null> {
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

    const spawnEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: [
        path.dirname(process.execPath),
        path.join(os.homedir(), '.npm-global', 'bin'),
        process.env.PATH || '',
      ].join(':'),
    };
    if (codexHomeOverride) {
      spawnEnv.CODEX_HOME = codexHomeOverride;
    }

    try {
      proc = spawn(codexBin, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
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

type UsageRow = {
  name: string;
  h5pct: number;
  h5reset: string;
  d7pct: number;
  d7reset: string;
};

export function mergeClaudeDashboardAccounts(
  liveAccounts: ClaudeAccountUsage[] | null | undefined,
  cachedAccounts: ClaudeAccountUsage[],
): ClaudeAccountUsage[] {
  if (!liveAccounts) return cachedAccounts;

  const cachedByIndex = new Map(
    cachedAccounts.map((account) => [account.index, account]),
  );

  return liveAccounts.map((account) => ({
    ...account,
    usage: account.usage || cachedByIndex.get(account.index)?.usage || null,
  }));
}

export function buildClaudeUsageRows(
  claudeAccounts: ClaudeAccountUsage[],
): UsageRow[] {
  const isMultiAccount = claudeAccounts.length > 1;

  return claudeAccounts.map((account) => {
    const usage = account.usage;
    const h5 = usage?.five_hour;
    const d7 = usage?.seven_day;
    const profile = getClaudeProfile(account.index);
    const planSuffix = profile ? ` ${profile.planType}` : '';
    const label = isMultiAccount
      ? `Claude${account.index + 1}${account.isActive ? '*' : ''}${account.isRateLimited ? '!' : ''}${planSuffix}`
      : `Claude${account.isActive ? '*' : ''}${account.isRateLimited ? '!' : ''}${planSuffix}`;

    return {
      name: label,
      h5pct: h5
        ? h5.utilization > 1
          ? Math.round(h5.utilization)
          : Math.round(h5.utilization * 100)
        : -1,
      h5reset: h5 ? formatResetRemaining(h5.resets_at) : '',
      d7pct: d7
        ? d7.utilization > 1
          ? Math.round(d7.utilization)
          : Math.round(d7.utilization * 100)
        : -1,
      d7reset: d7 ? formatResetRemaining(d7.resets_at) : '',
    };
  });
}

async function buildUsageContent(): Promise<string> {
  const shouldFetchClaudeUsage = USAGE_DASHBOARD_ENABLED;
  let liveClaudeAccounts: ClaudeAccountUsage[] | null = null;

  const codexUsagePromise = fetchCodexUsage();
  if (shouldFetchClaudeUsage) {
    try {
      liveClaudeAccounts = await fetchAllClaudeUsage();
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Claude usage for dashboard');
    }
  }
  const codexUsage = await codexUsagePromise;

  const lines: string[] = ['📊 *사용량*'];
  const bar = (pct: number) => {
    const filled = Math.round(pct / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  const rows: UsageRow[] = [];

  if (shouldFetchClaudeUsage) {
    cachedClaudeAccounts = mergeClaudeDashboardAccounts(
      liveClaudeAccounts,
      cachedClaudeAccounts,
    );
    rows.push(...buildClaudeUsageRows(cachedClaudeAccounts));
  }

  const codexAccounts = getAllCodexAccounts();
  if (codexAccounts.length > 1) {
    // Multi-account: show each account with plan + status
    for (const acct of codexAccounts) {
      const icon = acct.isActive ? '*' : acct.isRateLimited ? '!' : ' ';
      const label = `Codex${acct.index + 1}${icon}`;
      if (acct.isActive && codexUsage && Array.isArray(codexUsage)) {
        const relevant = codexUsage.filter(
          (limit) =>
            limit.primary.usedPercent > 0 || limit.secondary.usedPercent > 0,
        );
        const display = relevant.length > 0 ? relevant : codexUsage.slice(0, 1);
        for (const limit of display) {
          rows.push({
            name: `${label} ${acct.planType}`,
            h5pct: Math.round(limit.primary.usedPercent),
            h5reset: formatResetRemaining(limit.primary.resetsAt),
            d7pct: Math.round(limit.secondary.usedPercent),
            d7reset: formatResetRemaining(limit.secondary.resetsAt),
          });
        }
      } else {
        // Show cached usage from last scan
        const pct = acct.cachedUsagePct != null ? acct.cachedUsagePct : -1;
        const d7pct =
          acct.cachedUsageD7Pct != null ? acct.cachedUsageD7Pct : -1;
        const reset = acct.resetAt || '';
        const d7reset = acct.resetD7At || '';
        rows.push({
          name: `${label} ${acct.planType}`,
          h5pct: pct,
          h5reset: reset,
          d7pct,
          d7reset,
        });
      }
    }
  } else if (codexUsage && Array.isArray(codexUsage)) {
    // Single account: existing behavior
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
    // Emoji characters take 2 columns in monospace — count visual width
    const visualWidth = (s: string) =>
      [...s].reduce((w, c) => w + (c.codePointAt(0)! > 0x7f ? 2 : 1), 0);
    const maxNameWidth =
      Math.max(8, ...rows.map((r) => visualWidth(r.name))) + 1;
    const padName = (s: string) =>
      s + ' '.repeat(maxNameWidth - visualWidth(s));
    lines.push('```');
    lines.push(`${' '.repeat(maxNameWidth)}5-Hour             7-Day`);
    for (const row of rows) {
      const h5 =
        row.h5pct >= 0
          ? `${bar(row.h5pct)} ${String(row.h5pct).padStart(3)}%`
          : '  —  ';
      const d7 =
        row.d7pct >= 0
          ? `${bar(row.d7pct)} ${String(row.d7pct).padStart(3)}%`
          : '  —  ';
      const reset =
        row.h5reset || row.d7reset
          ? `  ${row.h5reset || ''}${row.d7reset ? ` / ${row.d7reset}` : ''}`
          : '';
      lines.push(`${padName(row.name)}${h5}   ${d7}${reset}`);
    }
    lines.push('```');
  } else {
    lines.push('_조회 불가_');
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

const CODEX_ACCOUNTS_DIR = path.join(os.homedir(), '.codex-accounts');
const CODEX_FULL_SCAN_INTERVAL = 3_600_000; // 1 hour

/**
 * Scan ALL Codex accounts by spawning app-server with each auth.
 * Called on startup and every hour to keep cached usage fresh.
 */
async function refreshAllCodexAccountUsage(): Promise<void> {
  const codexAccounts = getAllCodexAccounts();
  if (codexAccounts.length <= 1) return;

  logger.info(
    { accountCount: codexAccounts.length },
    'Scanning all Codex accounts for usage data',
  );

  for (const acct of codexAccounts) {
    const accountDir = path.join(CODEX_ACCOUNTS_DIR, String(acct.index + 1));
    if (!fs.existsSync(accountDir)) continue;

    try {
      const usage = await fetchCodexUsage(accountDir);
      if (usage && Array.isArray(usage)) {
        const relevant = usage.filter(
          (l) => l.primary.usedPercent > 0 || l.secondary.usedPercent > 0,
        );
        const display = relevant.length > 0 ? relevant : usage.slice(0, 1);
        if (usage.length > 0) {
          // Find max primary (5h) and secondary (7d) across all limits
          // Always capture reset times from first limit as baseline
          let maxH5 = 0;
          let maxD7 = 0;
          let h5Reset: string | number | undefined = usage[0].primary.resetsAt;
          let d7Reset: string | number | undefined =
            usage[0].secondary.resetsAt;
          for (const limit of usage) {
            if (limit.primary.usedPercent >= maxH5) {
              maxH5 = limit.primary.usedPercent;
              h5Reset = limit.primary.resetsAt;
            }
            if (limit.secondary.usedPercent >= maxD7) {
              maxD7 = limit.secondary.usedPercent;
              d7Reset = limit.secondary.resetsAt;
            }
          }
          const pct = Math.round(maxH5);
          const d7Pct = Math.round(maxD7);
          const resetStr = h5Reset ? formatResetRemaining(h5Reset) : undefined;
          const resetD7Str = d7Reset
            ? formatResetRemaining(d7Reset)
            : undefined;
          updateCodexAccountUsage(pct, resetStr, acct.index, d7Pct, resetD7Str);
          logger.info(
            { account: acct.index + 1, h5: pct, d7: d7Pct, reset: resetStr },
            `Codex account #${acct.index + 1} usage: 5h=${pct}% 7d=${d7Pct}%`,
          );
        }
      }
    } catch (err) {
      logger.debug(
        { err, account: acct.index + 1 },
        'Failed to fetch usage for Codex account',
      );
    }
  }
}

async function refreshUsageCache(): Promise<void> {
  if (usageUpdateInProgress) return;
  usageUpdateInProgress = true;
  try {
    cachedUsageContent = await buildUsageContent();
  } catch (err) {
    logger.warn({ err }, 'Failed to build usage content');
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
    await fetchAllClaudeProfiles();
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
        logger.warn(
          {
            cachedUsageLength: cachedUsageContent.length,
            statusShowRooms: STATUS_SHOW_ROOMS,
          },
          'Dashboard content empty, skipping render',
        );
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
      logger.warn({ err }, 'Dashboard update failed');
      statusMessageId = null;
    }
  };

  setInterval(updateStatus, opts.statusUpdateInterval);
  await updateStatus();

  if (isRenderer) {
    setInterval(refreshUsageCache, opts.usageUpdateInterval);
    // Full scan of all Codex accounts on startup + hourly
    // After scan, refresh dashboard so cached data is visible immediately
    void refreshAllCodexAccountUsage().then(() => {
      void refreshUsageCache().then(() => void updateStatus());
    });
    setInterval(
      () =>
        void refreshAllCodexAccountUsage().then(() => void refreshUsageCache()),
      CODEX_FULL_SCAN_INTERVAL,
    );
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
