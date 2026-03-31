import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  REVIEWER_AGENT_TYPE,
  SERVICE_ID,
  isSessionCommandSenderAllowed,
  STATUS_CHANNEL_ID,
  STATUS_UPDATE_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
  USAGE_UPDATE_INTERVAL,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { writeGroupsSnapshot } from './agent-runner.js';
import { listAvailableGroups } from './available-groups.js';
import {
  type AssignRoomInput,
  assignRoom,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLatestMessageSeqAtOrBefore,
  hasRecentRestartAnnouncement,
  getRouterState,
  initDatabase,
  setRouterState,
  deleteAllSessionsForGroup,
  deleteSession,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { composeDashboardContent } from './dashboard-render.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  findChannelByName,
  formatOutbound,
  normalizeMessageForDedupe,
} from './router.js';
import {
  buildRestartAnnouncement,
  buildInterruptedRestartAnnouncement,
  consumeRestartContext,
  getInterruptedRecoveryCandidates,
  inferRecentRestartContext,
  type RestartContext,
  writeShutdownRestartContext,
} from './restart-context.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { createMessageRuntime } from './message-runtime.js';
import { nudgeSchedulerLoop, startSchedulerLoop } from './task-scheduler.js';
import { startUnifiedDashboard } from './unified-dashboard.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { normalizeStoredSeqCursor } from './message-cursor.js';
import { initCodexTokenRotation } from './codex-token-rotation.js';
import {
  hasAvailableClaudeToken,
  initTokenRotation,
  onTokenRotated,
} from './token-rotation.js';
import {
  onTokenRefreshed,
  startTokenRefreshLoop,
  stopTokenRefreshLoop,
} from './token-refresh.js';
import {
  clearGlobalFailover,
  getGlobalFailoverInfo,
} from './service-routing.js';
import { FAILOVER_MIN_DURATION_MS } from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import { recreateAllReviewerContainers } from './container-runner.js';
import { cleanupOrphans, PROXY_BIND_HOST } from './container-runtime.js';

// Token rotation is initialized lazily on first use or at startup below

export async function sendFormattedChannelMessage(
  channels: Channel[],
  jid: string,
  rawText: string,
): Promise<void> {
  const channel = findChannel(channels, jid);
  if (!channel) {
    logger.warn({ jid }, 'No channel owns JID, cannot send message');
    return;
  }
  const text = formatOutbound(rawText);
  if (text) await channel.sendMessage(jid, text);
}

export async function sendFormattedTrackedChannelMessage(
  channels: Channel[],
  jid: string,
  rawText: string,
): Promise<string | null> {
  const channel = findChannel(channels, jid);
  if (!channel) {
    logger.warn({ jid }, 'No channel owns JID, cannot send tracked message');
    return null;
  }
  const text = formatOutbound(rawText);
  if (!text || !channel.sendAndTrack) return null;
  return channel.sendAndTrack(jid, text);
}

export async function editFormattedTrackedChannelMessage(
  channels: Channel[],
  jid: string,
  messageId: string,
  rawText: string,
): Promise<void> {
  const channel = findChannel(channels, jid);
  if (!channel) {
    logger.warn({ jid }, 'No channel owns JID, cannot edit tracked message');
    return;
  }
  const text = formatOutbound(rawText);
  if (!text || !channel.editMessage) return;
  await channel.editMessage(jid, messageId, text);
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

const channels: Channel[] = [];
const queue = new GroupQueue();
const runtime = createMessageRuntime({
  assistantName: ASSISTANT_NAME,
  idleTimeout: IDLE_TIMEOUT,
  pollInterval: POLL_INTERVAL,
  timezone: TIMEZONE,
  triggerPattern: TRIGGER_PATTERN,
  channels,
  queue,
  getRegisteredGroups: () => registeredGroups,
  getSessions: () => sessions,
  getLastTimestamp: () => lastTimestamp,
  setLastTimestamp: (timestamp) => {
    lastTimestamp = timestamp;
  },
  getLastAgentTimestamps: () => lastAgentTimestamp,
  saveState,
  persistSession: (groupFolder, sessionId) => {
    sessions[groupFolder] = sessionId;
    setSession(groupFolder, sessionId);
  },
  clearSession,
});

function loadState(): void {
  lastTimestamp = normalizeStoredSeqCursor(
    getRouterState('last_seq') || getRouterState('last_timestamp'),
  );
  const agentTs =
    getRouterState('last_agent_seq') || getRouterState('last_agent_timestamp');
  try {
    const parsed = agentTs
      ? (JSON.parse(agentTs) as Record<string, string>)
      : {};
    lastAgentTimestamp = Object.fromEntries(
      Object.entries(parsed).map(([chatJid, cursor]) => [
        chatJid,
        normalizeStoredSeqCursor(cursor, chatJid),
      ]),
    );
  } catch {
    logger.warn('Corrupted last_agent_seq in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    {
      groupCount: Object.keys(registeredGroups).length,
      agentType: 'unified',
    },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_seq', lastTimestamp);
  setRouterState('last_agent_seq', JSON.stringify(lastAgentTimestamp));
}

function clearSession(
  groupFolder: string,
  opts?: { allRoles?: boolean },
): void {
  delete sessions[groupFolder];
  if (opts?.allRoles) {
    deleteAllSessionsForGroup(groupFolder);
  } else {
    deleteSession(groupFolder);
  }
}

function assignRoomForIpc(jid: string, input: AssignRoomInput): void {
  const assignedGroup = assignRoom(jid, input);
  if (!assignedGroup) {
    logger.warn({ jid }, 'Failed to assign room from IPC');
    return;
  }

  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(assignedGroup.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: assignedGroup.folder, err },
      'Rejecting room assignment with invalid folder',
    );
    return;
  }

  const { jid: _ignoredJid, ...storedGroup } = assignedGroup;
  registeredGroups[jid] = storedGroup;
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./agent-runner.js').AvailableGroup[] {
  return listAvailableGroups(registeredGroups);
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

async function announceRestartRecovery(
  processStartedAtMs: number,
): Promise<RestartContext | null> {
  const explicitContext = consumeRestartContext();
  const dedupeSince = new Date(processStartedAtMs - 60_000).toISOString();
  if (explicitContext) {
    if (hasRecentRestartAnnouncement(explicitContext.chatJid, dedupeSince)) {
      logger.info(
        { chatJid: explicitContext.chatJid },
        'Skipped duplicate restart recovery announcement',
      );
      return explicitContext;
    }

    await sendFormattedChannelMessage(
      channels,
      explicitContext.chatJid,
      buildRestartAnnouncement(explicitContext),
    );
    logger.info(
      { chatJid: explicitContext.chatJid },
      'Sent explicit restart recovery announcement',
    );

    for (const interrupted of explicitContext.interruptedGroups ?? []) {
      if (interrupted.chatJid === explicitContext.chatJid) continue;
      if (hasRecentRestartAnnouncement(interrupted.chatJid, dedupeSince)) {
        continue;
      }
      await sendFormattedChannelMessage(
        channels,
        interrupted.chatJid,
        buildInterruptedRestartAnnouncement(interrupted),
      );
    }
    return explicitContext;
  }

  const inferred = inferRecentRestartContext(
    registeredGroups,
    processStartedAtMs,
  );
  if (!inferred) return null;

  if (hasRecentRestartAnnouncement(inferred.chatJid, dedupeSince)) {
    logger.info(
      { chatJid: inferred.chatJid },
      'Skipped duplicate inferred restart recovery announcement',
    );
    return null;
  }

  await sendFormattedChannelMessage(
    channels,
    inferred.chatJid,
    inferred.lines.join('\n'),
  );
  logger.info(
    { chatJid: inferred.chatJid },
    'Sent inferred restart recovery announcement',
  );
  return null;
}

async function main(): Promise<void> {
  const processStartedAtMs = Date.now();
  initDatabase();
  logger.info('Database initialized');
  initTokenRotation();
  initCodexTokenRotation();

  // Start credential proxy for container isolation and clean up orphaned containers
  startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST).catch((err) =>
    logger.warn(
      { err },
      'Failed to start credential proxy (may already be running)',
    ),
  );
  cleanupOrphans();

  // Recreate reviewer containers when OAuth tokens are rotated or refreshed.
  // Persistent containers hold the old token in their running SDK process;
  // removing them forces re-creation with fresh credentials on next turn.
  onTokenRotated(recreateAllReviewerContainers);
  onTokenRefreshed(recreateAllReviewerContainers);
  startTokenRefreshLoop();

  loadState();

  // Graceful shutdown handlers
  let leaseRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopTokenRefreshLoop();
    if (leaseRecoveryTimer) {
      clearInterval(leaseRecoveryTimer);
      leaseRecoveryTimer = null;
    }
    const interruptedGroups = queue
      .getStatuses(Object.keys(registeredGroups))
      .filter(
        (
          status,
        ): status is typeof status & {
          status: 'processing' | 'waiting';
        } => status.status !== 'inactive',
      )
      .map((status) => ({
        chatJid: status.jid,
        groupName: registeredGroups[status.jid]?.name || status.jid,
        status: status.status,
        elapsedMs: status.elapsedMs,
        pendingMessages: status.pendingMessages,
        pendingTasks: status.pendingTasks,
      }));
    const writtenPaths = writeShutdownRestartContext(
      registeredGroups,
      interruptedGroups,
      signal,
    );
    if (writtenPaths.length > 0) {
      logger.info(
        {
          signal,
          interruptedGroupCount: interruptedGroups.length,
          writtenPaths,
        },
        'Stored shutdown restart context for interrupted groups',
      );
    }
    await queue.shutdown(10000);
    cleanupOrphans();
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  // Resolve the reviewer channel so cron output in paired rooms is posted
  // via the reviewer bot — the owner then treats it as a peer request.
  const reviewerChannelName =
    REVIEWER_AGENT_TYPE === 'claude-code' ? 'discord' : 'discord-review';
  const reviewerChannelForCron = findChannelByName(
    channels,
    reviewerChannelName,
  );

  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, processName, ipcDir) =>
      queue.registerProcess(groupJid, proc, processName, ipcDir),
    sendMessage: (jid, rawText) =>
      sendFormattedChannelMessage(channels, jid, rawText),
    sendMessageViaReviewerBot: reviewerChannelForCron
      ? async (jid, rawText) => {
          const text = formatOutbound(rawText);
          if (text) await reviewerChannelForCron.sendMessage(jid, text);
        }
      : undefined,
    sendTrackedMessage: (jid, rawText) =>
      sendFormattedTrackedChannelMessage(channels, jid, rawText),
    editTrackedMessage: (jid, messageId, rawText) =>
      editFormattedTrackedChannelMessage(channels, jid, messageId, rawText),
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    nudgeScheduler: nudgeSchedulerLoop,
    registeredGroups: () => registeredGroups,
    assignRoom: assignRoomForIpc,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot,
  });
  queue.setProcessMessagesFn(runtime.processGroupMessages);
  queue.enterRecoveryMode();
  runtime.recoverPendingMessages();
  const restartContext = await announceRestartRecovery(processStartedAtMs);
  for (const candidate of getInterruptedRecoveryCandidates(
    restartContext,
    registeredGroups,
  )) {
    queue.enqueueMessageCheck(
      candidate.chatJid,
      resolveGroupIpcPath(candidate.groupFolder),
    );
    logger.info(
      {
        chatJid: candidate.chatJid,
        groupFolder: candidate.groupFolder,
        status: candidate.status,
        pendingMessages: candidate.pendingMessages,
        pendingTasks: candidate.pendingTasks,
      },
      'Queued interrupted group for restart recovery',
    );
  }
  await startUnifiedDashboard({
    assistantName: ASSISTANT_NAME,
    serviceId: SERVICE_ID,
    serviceAgentType: 'claude-code',
    statusChannelId: STATUS_CHANNEL_ID,
    statusUpdateInterval: STATUS_UPDATE_INTERVAL,
    usageUpdateInterval: USAGE_UPDATE_INTERVAL,
    channels,
    queue,
    registeredGroups: () => registeredGroups,
    onGroupNameSynced: (jid, name) => {
      const group = registeredGroups[jid];
      if (group) {
        group.name = name;
      }
    },
    purgeOnStart: true,
  });

  leaseRecoveryTimer = setInterval(() => {
    const failover = getGlobalFailoverInfo();
    if (!failover.active) return;
    if (!hasAvailableClaudeToken()) return;
    const activatedMs = failover.activatedAt
      ? new Date(failover.activatedAt).getTime()
      : NaN;
    if (Number.isNaN(activatedMs)) return;
    const elapsed = Date.now() - activatedMs;
    if (elapsed < FAILOVER_MIN_DURATION_MS) return;
    clearGlobalFailover();
    logger.info(
      { elapsedMin: Math.round(elapsed / 60_000) },
      'Claude token available and hold period elapsed, global failover cleared',
    );
  }, 5_000);
  runtime.startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start EJClaw');
    process.exit(1);
  });
}
