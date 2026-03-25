import { execSync } from 'child_process';
import os from 'os';

import { STATUS_SHOW_ROOMS, USAGE_DASHBOARD_ENABLED } from './config.js';
import {
  fetchAllClaudeUsage,
  fetchAllClaudeProfiles,
  type ClaudeAccountUsage,
} from './claude-usage.js';
import {
  CODEX_FULL_SCAN_INTERVAL,
  refreshActiveCodexUsage,
  refreshAllCodexAccountUsage,
} from './codex-usage-collector.js';
import {
  composeDashboardContent,
  formatElapsed,
  getStatusLabel as formatDashboardStatusLabel,
  type DashboardRoomLine,
  renderCategorizedRoomSections,
} from './dashboard-render.js';
import {
  buildClaudeUsageRows,
  extractCodexUsageRows,
  mergeClaudeDashboardAccounts,
  type UsageRow,
} from './dashboard-usage-rows.js';
import { getAllChats, getAllTasks, updateRegisteredGroupName } from './db.js';
import type { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { isWatchCiTask } from './task-watch-status.js';
import {
  readStatusSnapshots,
  writeStatusSnapshot,
} from './status-dashboard.js';
import type {
  AgentType,
  Channel,
  ChannelMeta,
  RegisteredGroup,
  ScheduledTask,
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

const STATUS_ICONS: Record<string, string> = {
  processing: '🟡',
  waiting: '🔵',
  inactive: '⚪',
};

const CHANNEL_META_REFRESH_MS = 300000;
const STATUS_SNAPSHOT_MAX_AGE_MS = 60000;
/** Usage data can be up to 10 min old before considered stale. */
const USAGE_SNAPSHOT_MAX_AGE_MS = 600_000;
/**
 * Renderer refreshes usage cache every 30s (not 5min).
 * Claude API calls are internally rate-limited to 5min per token,
 * so this only affects how quickly Codex snapshot data is picked up.
 */
const RENDERER_USAGE_REFRESH_MS = 30_000;

let statusMessageId: string | null = null;
let cachedUsageContent = '';
let cachedClaudeAccounts: ClaudeAccountUsage[] = [];
let usageUpdateInProgress = false;
let channelMetaCache = new Map<string, ChannelMeta>();
let channelMetaLastRefresh = 0;
let dashboardUpdateLogged = false;
/** Codex service only: cached usage rows written into the status snapshot. */
let cachedCodexUsageRows: UsageRow[] = [];
/** Codex service only: ISO timestamp of last successful usage fetch. */
let codexUsageFetchedAt: string | null = null;

export interface WatcherTaskSummary {
  active: number;
  paused: number;
}

export function summarizeWatcherTasks(
  tasks: Array<Pick<ScheduledTask, 'prompt' | 'status'>>,
): WatcherTaskSummary {
  let active = 0;
  let paused = 0;

  for (const task of tasks) {
    if (!isWatchCiTask(task)) continue;
    if (task.status === 'active') active += 1;
    if (task.status === 'paused') paused += 1;
  }

  return { active, paused };
}

export function formatStatusHeader(args: {
  totalActive: number;
  totalRooms: number;
  watchers: WatcherTaskSummary;
}): string {
  const parts = [
    `**📊 에이전트 상태** — 활성 ${args.totalActive} / ${args.totalRooms}`,
    `감시 ${args.watchers.active}`,
  ];

  if (args.watchers.paused > 0) {
    parts.push(`일시정지 ${args.watchers.paused}`);
  }

  return parts.join(' | ');
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
    ...(cachedCodexUsageRows.length > 0 && { usageRows: cachedCodexUsageRows }),
    ...(codexUsageFetchedAt && { usageRowsFetchedAt: codexUsageFetchedAt }),
  });
}

function buildStatusContent(): string {
  if (!STATUS_SHOW_ROOMS) return '';

  const snapshots = readStatusSnapshots(STATUS_SNAPSHOT_MAX_AGE_MS);
  const watcherSummary = summarizeWatcherTasks(getAllTasks());
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

  const header = formatStatusHeader({
    totalActive,
    totalRooms,
    watchers: watcherSummary,
  });
  const sections = renderCategorizedRoomSections({
    lines: roomLines,
    showCategoryHeaders: channelMetaCache.size > 0,
  });
  return `${header}\n\n${sections}`;
}

async function buildUsageContent(): Promise<string> {
  const shouldFetchClaudeUsage = USAGE_DASHBOARD_ENABLED;
  let liveClaudeAccounts: ClaudeAccountUsage[] | null = null;

  if (shouldFetchClaudeUsage) {
    try {
      liveClaudeAccounts = await fetchAllClaudeUsage();
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Claude usage for dashboard');
    }
  }

  const lines: string[] = ['📊 *사용량*'];
  const bar = (pct: number) => {
    const filled = Math.max(0, Math.min(5, Math.round(pct / 20)));
    return '█'.repeat(filled) + '░'.repeat(5 - filled);
  };

  const rows: UsageRow[] = [];

  if (shouldFetchClaudeUsage) {
    cachedClaudeAccounts = mergeClaudeDashboardAccounts(
      liveClaudeAccounts,
      cachedClaudeAccounts,
    );
    rows.push(...buildClaudeUsageRows(cachedClaudeAccounts));
  }

  // Codex usage: read from Codex service's own status snapshot.
  // Each service owns its usage data — no cross-service auth access needed.
  const codexSnapshot = readStatusSnapshots(STATUS_SNAPSHOT_MAX_AGE_MS).find(
    (s) => s.agentType === 'codex',
  );
  rows.push(...extractCodexUsageRows(codexSnapshot, USAGE_SNAPSHOT_MAX_AGE_MS));

  if (rows.length > 0) {
    // Emoji characters take 2 columns in monospace — count visual width
    const visualWidth = (s: string) =>
      [...s].reduce((w, c) => w + (c.codePointAt(0)! > 0x7f ? 2 : 1), 0);
    const maxNameWidth =
      Math.max(8, ...rows.map((r) => visualWidth(r.name))) + 1;
    const padName = (s: string) =>
      s + ' '.repeat(Math.max(0, maxNameWidth - visualWidth(s)));
    // Strip whitespace and trailing 'm' from reset strings for compact display
    const compactReset = (s: string) =>
      s ? s.replace(/\s+/g, '').replace(/m$/, '') : '';

    lines.push('```');
    lines.push(`${' '.repeat(maxNameWidth)}5h        7d`);
    for (const row of rows) {
      const h5 =
        row.h5pct >= 0
          ? `${bar(row.h5pct)}${String(row.h5pct).padStart(3)}%`
          : ' —   ';
      const d7 =
        row.d7pct >= 0
          ? `${bar(row.d7pct)}${String(row.d7pct).padStart(3)}%`
          : ' —   ';
      lines.push(`${padName(row.name)}${h5} ${d7}`);
      const r5 = compactReset(row.h5reset);
      const r7 = compactReset(row.d7reset);
      if (r5 || r7) {
        // Align reset values under 5h / 7d columns
        // h5 column starts at maxNameWidth; d7 column starts at maxNameWidth + 9 + 1
        const d7ColStart = maxNameWidth + 10;
        let resetLine = ' '.repeat(maxNameWidth);
        if (r5) resetLine += r5;
        resetLine = resetLine.padEnd(d7ColStart);
        if (r7) resetLine += r7;
        lines.push(resetLine);
      }
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
      if (!dashboardUpdateLogged) {
        logger.info(
          { messageId: statusMessageId, contentLength: content.length },
          'Dashboard updated successfully (first)',
        );
        dashboardUpdateLogged = true;
      }
    } catch (err) {
      logger.warn({ err }, 'Dashboard update failed');
      statusMessageId = null;
    }
  };

  setInterval(updateStatus, opts.statusUpdateInterval);
  await updateStatus();

  if (isRenderer) {
    // Renderer: refresh usage cache at shorter interval so Codex snapshot
    // data is picked up quickly. Claude API calls are internally rate-limited
    // to 5min per token, so this only affects local reads.
    setInterval(refreshUsageCache, RENDERER_USAGE_REFRESH_MS);
  } else {
    // Codex service: fetch own usage and expose via status snapshot.
    // Active account every usageUpdateInterval; full scan on startup + hourly.
    // Collector returns data; we own the cache state.
    const applyRefresh = (result: {
      rows: UsageRow[];
      fetchedAt: string | null;
    }) => {
      cachedCodexUsageRows = result.rows;
      if (result.fetchedAt) codexUsageFetchedAt = result.fetchedAt;
    };
    void refreshAllCodexAccountUsage().then((r) => {
      applyRefresh(r);
      return refreshActiveCodexUsage().then(applyRefresh);
    });
    setInterval(
      () => void refreshActiveCodexUsage().then(applyRefresh),
      opts.usageUpdateInterval,
    );
    setInterval(
      () => void refreshAllCodexAccountUsage().then(applyRefresh),
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
