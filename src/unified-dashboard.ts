import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import {
  ARBITER_AGENT_TYPE,
  ARBITER_MODEL_CONFIG,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  OWNER_AGENT_TYPE,
  OWNER_MODEL_CONFIG,
  REVIEWER_AGENT_TYPE,
  REVIEWER_MODEL_CONFIG,
  STATUS_SHOW_ROOM_DETAILS,
  STATUS_SHOW_ROOMS,
  USAGE_DASHBOARD_ENABLED,
  CODEX_WARMUP_CONFIG,
  getMoaConfig,
} from './config.js';
import {
  fetchKimiUsage,
  buildKimiUsageRows,
  type KimiUsageData,
} from './kimi-usage.js';
import { getGlobalFailoverInfo } from './service-routing.js';
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
import { runCodexWarmupCycle } from './codex-warmup.js';
import {
  composeDashboardContent,
  formatElapsed,
  getStatusLabel as formatDashboardStatusLabel,
  type DashboardRoomLine,
  renderCategorizedRoomSections,
} from './dashboard-render.js';
import {
  cleanupDashboardDuplicateMessages,
  purgeDashboardMessages,
} from './dashboard-message-cleanup.js';
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
  readDashboardStatusMessageId,
  readStatusSnapshots,
  writeDashboardStatusMessageId,
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
  serviceId: string;
  serviceAgentType: AgentType;
  statusChannelId: string;
  statusUpdateInterval: number;
  usageUpdateInterval: number;
  channels: Channel[];
  queue: GroupQueue;
  roomBindings: () => Record<string, RegisteredGroup>;
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
const DASHBOARD_DUPLICATE_CLEANUP_POLL_MS = 2_000;

let statusMessageId: string | null = null;
let cachedUsageContent = '';
let cachedClaudeAccounts: ClaudeAccountUsage[] = [];
let cachedKimiUsage: KimiUsageData | null = null;
let usageUpdateInProgress = false;
let channelMetaCache = new Map<string, ChannelMeta>();
let channelMetaLastRefresh = 0;
let dashboardUpdateLogged = false;
/** Codex service only: cached usage rows written into the status snapshot. */
let cachedCodexUsageRows: UsageRow[] = [];
/** Codex service only: ISO timestamp of last successful usage fetch. */
let codexUsageFetchedAt: string | null = null;
/** Renderer service only: ISO timestamp of last successful Claude/Kimi usage render. */
let rendererUsageFetchedAt: string | null = null;

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
  await purgeDashboardMessages(opts);
}

export function shouldPurgeDashboardChannelOnStart(args: {
  purgeOnStart?: boolean;
  storedMessageId: string | null;
}): boolean {
  return args.purgeOnStart === true;
}

export function getDashboardDuplicateCleanupIntervalMs(
  statusUpdateInterval: number,
): number {
  return Math.min(statusUpdateInterval, DASHBOARD_DUPLICATE_CLEANUP_POLL_MS);
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

  const localJids = Object.keys(opts.roomBindings()).filter((jid) =>
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
      const group = opts.roomBindings()[jid];
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

function getAgentDisplayName(
  agentType: 'claude-code' | 'codex',
  serviceId: string,
): string {
  if (agentType === 'claude-code') return '클코';
  return serviceId === 'codex-review' ? '코리뷰' : '코덱스';
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

export function buildWebUsageRowsForSnapshot(args: {
  serviceAgentType: AgentType;
  claudeAccounts: ClaudeAccountUsage[];
  kimiUsage: KimiUsageData | null;
  codexRows: UsageRow[];
}): UsageRow[] {
  const rows: UsageRow[] = [];

  if (args.serviceAgentType === 'claude-code') {
    rows.push(...buildClaudeUsageRows(args.claudeAccounts));
    rows.push(...buildKimiUsageRows(args.kimiUsage));
  }

  rows.push(...args.codexRows);
  return rows;
}

function buildUsageSnapshotRows(opts: UnifiedDashboardOptions): {
  rows: UsageRow[];
  fetchedAt: string | null;
} {
  const rows = buildWebUsageRowsForSnapshot({
    serviceAgentType: opts.serviceAgentType,
    claudeAccounts: cachedClaudeAccounts,
    kimiUsage: cachedKimiUsage,
    codexRows: cachedCodexUsageRows,
  });

  const fetchedAt =
    [rendererUsageFetchedAt, codexUsageFetchedAt]
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null;

  return { rows, fetchedAt };
}

function writeLocalStatusSnapshot(opts: UnifiedDashboardOptions): void {
  const groups = opts.roomBindings();
  const statuses = opts.queue.getStatuses(Object.keys(groups));
  const usageSnapshot = buildUsageSnapshotRows(opts);

  writeStatusSnapshot({
    serviceId: opts.serviceId,
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
    ...(usageSnapshot.rows.length > 0 && { usageRows: usageSnapshot.rows }),
    ...(usageSnapshot.fetchedAt && {
      usageRowsFetchedAt: usageSnapshot.fetchedAt,
    }),
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
    serviceId: string;
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
        serviceId: snapshot.serviceId,
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
        const tag = getAgentDisplayName(agent.agentType, agent.serviceId);
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
  if (!STATUS_SHOW_ROOM_DETAILS) {
    return header;
  }

  const sections = renderCategorizedRoomSections({
    lines: roomLines,
    showCategoryHeaders: channelMetaCache.size > 0,
  });
  return `${header}\n\n${sections}`;
}

/**
 * Render usage table lines from two row groups (Claude and Codex).
 * Returns rendered lines including code block markers.
 * Ordering: Claude rows → separator → Codex rows.
 * Exported for testing.
 */
export function renderUsageTable(
  claudeBotRows: UsageRow[],
  codexBotRows: UsageRow[],
): string[] {
  const allRows = [...claudeBotRows, ...codexBotRows];
  if (allRows.length === 0) return ['_조회 불가_'];

  const bar = (pct: number) => {
    const filled = Math.max(0, Math.min(5, Math.round(pct / 20)));
    return '█'.repeat(filled) + '░'.repeat(5 - filled);
  };

  const visualWidth = (s: string) =>
    [...s].reduce((w, c) => w + (c.codePointAt(0)! > 0x7f ? 2 : 1), 0);
  const maxNameWidth =
    Math.max(8, ...allRows.map((r) => visualWidth(r.name))) + 1;
  const padName = (s: string) =>
    s + ' '.repeat(Math.max(0, maxNameWidth - visualWidth(s)));
  const compactReset = (s: string) =>
    s ? s.replace(/\s+/g, '').replace(/m$/, '') : '';

  const lines: string[] = [];

  const renderRows = (rows: UsageRow[]) => {
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
        const d7ColStart = maxNameWidth + 10;
        let resetLine = ' '.repeat(maxNameWidth);
        if (r5) resetLine += r5;
        resetLine = resetLine.padEnd(d7ColStart);
        if (r7) resetLine += r7;
        lines.push(resetLine);
      }
    }
  };

  lines.push('```');
  lines.push(`${' '.repeat(maxNameWidth)}5h        7d`);

  renderRows(claudeBotRows);

  if (claudeBotRows.length > 0 && codexBotRows.length > 0) {
    const separatorWidth = maxNameWidth + 20;
    lines.push('─'.repeat(separatorWidth));
  }

  renderRows(codexBotRows);

  lines.push('```');

  return lines;
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

  // Kimi usage
  try {
    cachedKimiUsage = await fetchKimiUsage();
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch Kimi usage for dashboard');
  }

  const lines: string[] = ['📊 *사용량*'];
  const bar = (pct: number) => {
    const filled = Math.max(0, Math.min(5, Math.round(pct / 20)));
    return '█'.repeat(filled) + '░'.repeat(5 - filled);
  };

  // Group 1: Claude bot
  const claudeBotRows: UsageRow[] = [];

  if (shouldFetchClaudeUsage) {
    cachedClaudeAccounts = mergeClaudeDashboardAccounts(
      liveClaudeAccounts,
      cachedClaudeAccounts,
    );
    claudeBotRows.push(...buildClaudeUsageRows(cachedClaudeAccounts));
  }

  // Group 2: Codex bot — use in-process cache (unified service)
  // or fall back to snapshot from separate Codex service.
  const codexBotRows: UsageRow[] = [];
  if (cachedCodexUsageRows.length > 0) {
    codexBotRows.push(...cachedCodexUsageRows);
  } else {
    const codexSnapshot = readStatusSnapshots(STATUS_SNAPSHOT_MAX_AGE_MS).find(
      (s) => s.serviceId === 'codex-main' || s.serviceId === 'codex',
    );
    codexBotRows.push(
      ...extractCodexUsageRows(codexSnapshot, USAGE_SNAPSHOT_MAX_AGE_MS),
    );
  }

  // Group 3: Kimi coding plan
  const kimiRows = buildKimiUsageRows(cachedKimiUsage);
  claudeBotRows.push(...kimiRows);

  lines.push(...renderUsageTable(claudeBotRows, codexBotRows));

  lines.push('');
  lines.push('🖥️ *서버*');

  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuPct = Math.round((loadAvg[1] / cpuCount) * 100);
  const totalMem = os.totalmem();
  // os.freemem() includes buffers/cache as "used" — misleading.
  // Read MemAvailable from /proc/meminfo for actual available memory.
  let availableMem = os.freemem();
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
    const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (match) availableMem = parseInt(match[1], 10) * 1024;
  } catch {
    /* non-Linux or unreadable — fall back to os.freemem() */
  }
  const usedMem = totalMem - availableMem;
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

function buildModelConfigSection(): string {
  const roleConfigs = [
    {
      label: 'Owner',
      agentType: OWNER_AGENT_TYPE,
      model: OWNER_MODEL_CONFIG.model,
    },
    {
      label: 'Reviewer',
      agentType: REVIEWER_AGENT_TYPE,
      model: REVIEWER_MODEL_CONFIG.model,
    },
    {
      label: 'Arbiter',
      agentType: ARBITER_AGENT_TYPE,
      model: ARBITER_MODEL_CONFIG.model,
    },
  ];

  const failover = getGlobalFailoverInfo();
  const lines = ['🤖 *모델 구성*'];
  for (const role of roleConfigs) {
    if (!role.agentType && role.label === 'Arbiter') continue;
    const type = role.agentType || '—';
    const defaultModel =
      type === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL;
    const model = role.model || defaultModel;

    // Show fallback status for claude-code roles when global failover is active
    const isFallback = failover.active && type === 'claude-code';
    if (isFallback) {
      const fallbackModel = DEFAULT_CODEX_MODEL;
      lines.push(`  **${role.label}** — codex \`${fallbackModel}\` (fallback)`);
    } else {
      lines.push(`  **${role.label}** — ${type} \`${model}\``);
    }
  }

  // MoA status
  const moaConfig = getMoaConfig();
  if (moaConfig.enabled) {
    const refs = moaConfig.referenceModels
      .map((m) => `${m.name} \`${m.model}\``)
      .join(', ');
    lines.push(`  **MoA** — ${refs}`);
  }

  if (failover.active) {
    lines.push(`  ⚠️ **Failover 활성** — ${failover.reason || '알 수 없음'}`);
  }

  return lines.join('\n');
}

function buildUnifiedDashboardContent(): string {
  const sections: string[] = [];
  sections.push(buildModelConfigSection());
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
    rendererUsageFetchedAt = new Date().toISOString();
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
  if (isRenderer) {
    statusMessageId = readDashboardStatusMessageId(opts.statusChannelId);
  }

  if (
    isRenderer &&
    shouldPurgeDashboardChannelOnStart({
      purgeOnStart: opts.purgeOnStart,
      storedMessageId: statusMessageId,
    })
  ) {
    await purgeDashboardChannel(opts);
    statusMessageId = null;
  }

  if (isRenderer) {
    await fetchAllClaudeProfiles();
    await refreshUsageCache();
  }

  const updateStatus = async () => {
    writeLocalStatusSnapshot(opts);
    if (!isRenderer) return;

    const channel = findDiscordChannel(opts.channels);
    if (!channel) {
      logger.warn(
        {
          channelCount: opts.channels.length,
          names: opts.channels.map((c) => c.name),
          connected: opts.channels.map((c) => c.isConnected()),
        },
        'Dashboard: no connected Discord channel found',
      );
      return;
    }

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
        return;
      }

      if (statusMessageId && channel.editMessage) {
        try {
          await channel.editMessage(statusJid, statusMessageId, content);
          writeDashboardStatusMessageId(opts.statusChannelId, statusMessageId);
        } catch (err) {
          logger.warn(
            { err, messageId: statusMessageId },
            'Dashboard status message edit failed; sending a fresh tracked message',
          );
          statusMessageId = null;
        }
      }

      if (!statusMessageId && channel.sendAndTrack) {
        const id = await channel.sendAndTrack(statusJid, content);
        if (id) {
          statusMessageId = id;
          writeDashboardStatusMessageId(opts.statusChannelId, id);
        }
      }
      if (statusMessageId) {
        await cleanupDashboardDuplicateMessages(opts, statusMessageId);
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
  setInterval(() => {
    if (!isRenderer || !statusMessageId) return;
    void cleanupDashboardDuplicateMessages(opts, statusMessageId);
  }, getDashboardDuplicateCleanupIntervalMs(opts.statusUpdateInterval));
  await updateStatus();

  if (isRenderer) {
    setInterval(refreshUsageCache, RENDERER_USAGE_REFRESH_MS);
  }

  // Codex usage collection — runs in unified service regardless of renderer role.
  const applyCodexRefresh = (result: {
    rows: UsageRow[];
    fetchedAt: string | null;
  }) => {
    cachedCodexUsageRows = result.rows;
    if (result.fetchedAt) codexUsageFetchedAt = result.fetchedAt;
  };
  const isWarmupRuntimeBusy = () => {
    const groups = opts.roomBindings();
    return opts.queue
      .getStatuses(Object.keys(groups))
      .some((status) => status.status === 'processing');
  };
  let codexWarmupInFlight = false;
  const runCodexWarmup = async () => {
    if (!CODEX_WARMUP_CONFIG.enabled || codexWarmupInFlight) return;
    codexWarmupInFlight = true;
    try {
      const result = await runCodexWarmupCycle(CODEX_WARMUP_CONFIG, {
        shouldSkip: isWarmupRuntimeBusy,
      });
      if (result.status === 'warmed') {
        applyCodexRefresh(await refreshAllCodexAccountUsage());
      }
    } catch (err) {
      logger.warn({ err }, 'Codex warm-up cycle failed unexpectedly');
    } finally {
      codexWarmupInFlight = false;
    }
  };
  void refreshAllCodexAccountUsage()
    .then((r) => {
      applyCodexRefresh(r);
      return refreshActiveCodexUsage().then(applyCodexRefresh);
    })
    .then(() => runCodexWarmup());
  setInterval(
    () => void refreshActiveCodexUsage().then(applyCodexRefresh),
    opts.usageUpdateInterval,
  );
  setInterval(
    () =>
      void refreshAllCodexAccountUsage()
        .then(applyCodexRefresh)
        .then(() => runCodexWarmup()),
    CODEX_FULL_SCAN_INTERVAL,
  );
  if (CODEX_WARMUP_CONFIG.enabled) {
    setInterval(() => void runCodexWarmup(), CODEX_WARMUP_CONFIG.intervalMs);
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
