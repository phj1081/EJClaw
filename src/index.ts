import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  SERVICE_ID,
  STATUS_CHANNEL_ID,
  STATUS_UPDATE_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
  USAGE_UPDATE_INTERVAL,
  WEB_DASHBOARD,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { writeGroupsSnapshot } from './agent-runner.js';
import {
  hasRecentRestartAnnouncement,
  initDatabase,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  deliverCanonicalOutboundMessage,
  deliverIpcOutboundMessage,
} from './ipc-outbound-delivery.js';
import { findChannel, formatOutbound } from './router.js';
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
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { createMessageRuntime } from './message-runtime.js';
import { nudgeSchedulerLoop, startSchedulerLoop } from './task-scheduler.js';
import { startUnifiedDashboard } from './unified-dashboard.js';
import { startWebDashboardServer } from './web-dashboard-server.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { initCodexTokenRotation } from './codex-token-rotation.js';
import {
  startCodexAccountRefreshLoop,
  stopCodexAccountRefreshLoop,
} from './settings-store.js';
import {
  hasAvailableClaudeToken,
  initTokenRotation,
} from './token-rotation.js';
import {
  isBotMessageSourceKind,
  resolveInjectedMessageSourceKind,
} from './message-source.js';
import { parseVisibleVerdict } from './paired-verdict.js';

export function isTerminalStatusMessage(text: string): boolean {
  return parseVisibleVerdict(text) !== 'continue';
}
import {
  startTokenRefreshLoop,
  stopTokenRefreshLoop,
} from './token-refresh.js';
import {
  clearGlobalFailover,
  getGlobalFailoverInfo,
} from './service-routing.js';
import { resolveStartupFailureExitCode } from './startup-preconditions.js';
import { createRuntimeState } from './runtime-state.js';
import { FAILOVER_MIN_DURATION_MS } from './config.js';

// Token rotation is initialized lazily on first use or at startup below

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

const channels: Channel[] = [];
const queue = new GroupQueue();
const runtimeState = createRuntimeState();
const runtime = createMessageRuntime({
  assistantName: ASSISTANT_NAME,
  idleTimeout: IDLE_TIMEOUT,
  pollInterval: POLL_INTERVAL,
  timezone: TIMEZONE,
  triggerPattern: TRIGGER_PATTERN,
  channels,
  queue,
  getRoomBindings: runtimeState.getRoomBindings,
  getSessions: runtimeState.getSessions,
  getLastTimestamp: runtimeState.getLastTimestamp,
  setLastTimestamp: runtimeState.setLastTimestamp,
  getLastAgentTimestamps: runtimeState.getLastAgentTimestamps,
  saveState: runtimeState.saveState,
  persistSession: runtimeState.persistSession,
  clearSession: runtimeState.clearSession,
});

async function deliverFormattedCanonicalMessage(
  jid: string,
  rawText: string,
  deliveryRole?: 'owner' | 'reviewer' | 'arbiter',
): Promise<void> {
  const text = formatOutbound(rawText);
  if (!text) return;
  await deliverCanonicalOutboundMessage(
    { jid, text, deliveryRole },
    {
      channels,
      roomBindings: runtimeState.getRoomBindings,
      log: logger,
    },
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./agent-runner.js').AvailableGroup[] {
  return runtimeState.getAvailableGroups();
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  runtimeState.setRoomBindings(groups);
}

/** @internal - exported for testing */
export function _setRoomBindings(
  groups: Record<string, RegisteredGroup>,
): void {
  runtimeState.setRoomBindings(groups);
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

    await deliverFormattedCanonicalMessage(
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
      await deliverFormattedCanonicalMessage(
        interrupted.chatJid,
        buildInterruptedRestartAnnouncement(interrupted),
      );
    }
    return explicitContext;
  }

  const inferred = inferRecentRestartContext(
    runtimeState.getRoomBindings(),
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

  await deliverFormattedCanonicalMessage(
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
  startTokenRefreshLoop();
  startCodexAccountRefreshLoop();

  runtimeState.loadState();

  // Graceful shutdown handlers
  let leaseRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  let webDashboardServer: ReturnType<typeof startWebDashboardServer> = null;
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopTokenRefreshLoop();
    stopCodexAccountRefreshLoop();
    if (leaseRecoveryTimer) {
      clearInterval(leaseRecoveryTimer);
      leaseRecoveryTimer = null;
    }
    webDashboardServer?.stop();
    webDashboardServer = null;
    const roomBindings = runtimeState.getRoomBindings();
    const interruptedGroups = queue
      .getStatuses(Object.keys(roomBindings))
      .filter(
        (
          status,
        ): status is typeof status & {
          status: 'processing' | 'waiting';
        } => status.status !== 'inactive',
      )
      .map((status) => ({
        chatJid: status.jid,
        groupName: roomBindings[status.jid]?.name || status.jid,
        status: status.status,
        elapsedMs: status.elapsedMs,
        pendingMessages: status.pendingMessages,
        pendingTasks: status.pendingTasks,
      }));
    const writtenPaths = writeShutdownRestartContext(
      roomBindings,
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
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      const roomBindings = runtimeState.getRoomBindings();
      if (!msg.is_from_me && !msg.is_bot_message && roomBindings[chatJid]) {
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
    roomBindings: runtimeState.getRoomBindings,
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
  startSchedulerLoop({
    roomBindings: runtimeState.getRoomBindings,
    getSessions: runtimeState.getSessions,
    queue,
    onProcess: (groupJid, proc, processName, ipcDir) =>
      queue.registerProcess(groupJid, proc, processName, ipcDir),
    sendMessage: (jid, rawText) =>
      deliverFormattedCanonicalMessage(jid, rawText),
    sendMessageViaReviewerBot: (jid, rawText) =>
      deliverFormattedCanonicalMessage(jid, rawText, 'reviewer'),
    sendTrackedMessage: (jid, rawText) =>
      sendFormattedTrackedChannelMessage(channels, jid, rawText),
    editTrackedMessage: (jid, messageId, rawText) =>
      editFormattedTrackedChannelMessage(channels, jid, messageId, rawText),
  });
  startIpcWatcher({
    sendMessage: async (jid, text, senderRole, runId, attachments) => {
      await deliverIpcOutboundMessage(
        { jid, text, senderRole, runId, attachments },
        {
          channels,
          roomBindings: runtimeState.getRoomBindings,
          queue,
          log: logger,
        },
      );
    },
    injectInboundMessage: async (payload) => {
      const jid = payload.chatJid;
      const binding = runtimeState.getRoomBindings()[jid];
      if (!binding) {
        logger.warn(
          { chatJid: jid, sender: payload.sender ?? null },
          'inject_inbound_message: no room binding, dropping',
        );
        return;
      }
      const ts = payload.timestamp || new Date().toISOString();
      const msgId =
        payload.messageId ||
        `ipc-inject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const treatAsHuman = payload.treatAsHuman === true;
      const messageSourceKind = resolveInjectedMessageSourceKind({
        treatAsHuman,
        sourceKind: payload.sourceKind,
      });
      storeChatMetadata(jid, ts, binding.name, 'discord', true);
      storeMessage({
        id: msgId,
        chat_jid: jid,
        sender: payload.sender || 'ipc-inject',
        sender_name: payload.senderName || payload.sender || 'IPC Inject',
        content: payload.text,
        timestamp: ts,
        is_from_me: false,
        is_bot_message: isBotMessageSourceKind(messageSourceKind),
        message_source_kind: messageSourceKind,
      });
      queue.enqueueMessageCheck(jid, resolveGroupIpcPath(binding.folder));
      logger.info(
        {
          chatJid: jid,
          sender: payload.sender ?? null,
          senderName: payload.senderName ?? null,
          treatAsHuman,
          messageSourceKind,
          messageId: msgId,
          groupFolder: binding.folder,
        },
        'Injected inbound message via IPC',
      );
    },
    nudgeScheduler: nudgeSchedulerLoop,
    roomBindings: runtimeState.getRoomBindings,
    assignRoom: runtimeState.assignRoomForIpc,
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
  const roomBindings = runtimeState.getRoomBindings();
  for (const candidate of getInterruptedRecoveryCandidates(
    restartContext,
    roomBindings,
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
    roomBindings: runtimeState.getRoomBindings,
    onGroupNameSynced: (jid, name) => {
      const group = runtimeState.getRoomBindings()[jid];
      if (group) {
        group.name = name;
      }
    },
    purgeOnStart: true,
  });
  webDashboardServer = startWebDashboardServer({
    ...WEB_DASHBOARD,
    getRoomBindings: runtimeState.getRoomBindings,
    enqueueMessageCheck: (chatJid, groupFolder) =>
      queue.enqueueMessageCheck(chatJid, resolveGroupIpcPath(groupFolder)),
    nudgeScheduler: nudgeSchedulerLoop,
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
    const exitCode = resolveStartupFailureExitCode(err);
    logger.error({ err, exitCode }, 'Failed to start EJClaw');
    process.exit(exitCode);
  });
}
