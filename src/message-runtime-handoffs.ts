import { SERVICE_SESSION_SCOPE } from './config.js';
import { getErrorMessage } from './utils.js';
import {
  claimServiceHandoff,
  completeServiceHandoffAndAdvanceTargetCursor,
  failServiceHandoff,
  getPairedTaskById,
  getPendingServiceHandoffs,
  type ServiceHandoff,
} from './db.js';
import { findChannel, findChannelByName } from './router.js';
import { logger } from './logger.js';
import { schedulePairedFollowUpWithMessageCheck } from './message-runtime-follow-up.js';
import {
  getFixedRoleChannelName,
  getMissingRoleChannelMessage,
  resolveHandoffCursorKey,
  resolveHandoffRoleOverride,
} from './message-runtime-shared.js';
import { buildPairedTurnIdentity } from './paired-turn-identity.js';
import type { ScheduledPairedFollowUpIntentKind } from './paired-follow-up-scheduler.js';
import type { ExecuteTurnFn } from './message-runtime-types.js';
import type {
  Channel,
  PairedRoomRole,
  PairedTask,
  RegisteredGroup,
} from './types.js';

export function enqueuePendingHandoffs(args: {
  enqueueTask: (
    chatJid: string,
    taskId: string,
    task: () => Promise<void>,
  ) => void;
  processClaimedHandoff: (handoff: ServiceHandoff) => Promise<void>;
}): void {
  for (const handoff of getPendingServiceHandoffs(SERVICE_SESSION_SCOPE)) {
    if (!claimServiceHandoff(handoff.id)) {
      continue;
    }

    args.enqueueTask(handoff.chat_jid, `handoff:${handoff.id}`, async () => {
      await args.processClaimedHandoff(handoff);
    });
  }
}

export function enqueueMessageRuntimePendingHandoffs(args: {
  enqueueTask?:
    | ((chatJid: string, taskId: string, task: () => Promise<void>) => void)
    | undefined;
  getRoomBindings: () => Record<string, RegisteredGroup>;
  channels: Channel[];
  executeTurn: ExecuteTurnFn;
  getLastAgentTimestamps: () => Record<string, string>;
  saveState: () => void;
  enqueueMessageCheck: (chatJid: string) => void;
}): void {
  enqueuePendingHandoffs({
    enqueueTask: (chatJid, taskId, task) => {
      args.enqueueTask?.(chatJid, taskId, task);
    },
    processClaimedHandoff: async (handoff) => {
      await processClaimedHandoff({
        handoff,
        getRoomBindings: args.getRoomBindings,
        channels: args.channels,
        executeTurn: args.executeTurn,
        lastAgentTimestamps: args.getLastAgentTimestamps(),
        saveState: args.saveState,
        getPairedTaskById,
        enqueueMessageCheck: args.enqueueMessageCheck,
      });
    },
  });
}

function requeueFailedClaimedPairedTurn(args: {
  handoff: ServiceHandoff;
  error: string;
  getPairedTaskById?:
    | ((
        id: string,
      ) =>
        | Pick<PairedTask, 'id' | 'status' | 'round_trip_count' | 'updated_at'>
        | undefined)
    | undefined;
  enqueueMessageCheck?: ((chatJid: string) => void) | undefined;
}): void {
  const { handoff, error, getPairedTaskById, enqueueMessageCheck } = args;
  if (
    !handoff.paired_task_id ||
    !handoff.paired_task_updated_at ||
    !handoff.turn_intent_kind ||
    !getPairedTaskById ||
    !enqueueMessageCheck
  ) {
    return;
  }

  const task = getPairedTaskById(handoff.paired_task_id);
  if (!task) {
    logger.warn(
      {
        chatJid: handoff.chat_jid,
        handoffId: handoff.id,
        taskId: handoff.paired_task_id,
        error,
      },
      'Skipped paired turn retry after claimed service handoff failure because the paired task no longer exists',
    );
    return;
  }

  if (!isScheduledPairedFollowUpIntentKind(handoff.turn_intent_kind)) {
    logger.warn(
      {
        chatJid: handoff.chat_jid,
        handoffId: handoff.id,
        taskId: handoff.paired_task_id,
        intentKind: handoff.turn_intent_kind,
        error,
      },
      'Skipped paired turn retry after claimed service handoff failure because the persisted turn intent is not schedulable',
    );
    return;
  }

  if (task.updated_at !== handoff.paired_task_updated_at) {
    logger.warn(
      {
        chatJid: handoff.chat_jid,
        handoffId: handoff.id,
        taskId: handoff.paired_task_id,
        expectedTaskUpdatedAt: handoff.paired_task_updated_at,
        actualTaskUpdatedAt: task.updated_at,
        error,
      },
      'Skipped paired turn retry after claimed service handoff failure because the paired task revision changed',
    );
    return;
  }

  const scheduled = schedulePairedFollowUpWithMessageCheck({
    chatJid: handoff.chat_jid,
    runId: `handoff-${handoff.id}-retry`,
    task,
    intentKind: handoff.turn_intent_kind,
    enqueueMessageCheck: () => enqueueMessageCheck(handoff.chat_jid),
  });
  logger.info(
    {
      chatJid: handoff.chat_jid,
      handoffId: handoff.id,
      taskId: task.id,
      taskStatus: task.status,
      taskUpdatedAt: task.updated_at,
      intentKind: handoff.turn_intent_kind,
      turnId: handoff.turn_id ?? null,
      scheduled,
      error,
    },
    scheduled
      ? 'Queued paired turn retry after claimed service handoff failure'
      : 'Skipped duplicate paired turn retry after claimed service handoff failure while task state was unchanged',
  );
}

function isScheduledPairedFollowUpIntentKind(
  intentKind: ServiceHandoff['turn_intent_kind'],
): intentKind is ScheduledPairedFollowUpIntentKind {
  return (
    intentKind === 'reviewer-turn' ||
    intentKind === 'arbiter-turn' ||
    intentKind === 'owner-follow-up' ||
    intentKind === 'finalize-owner-turn'
  );
}

function failClaimedHandoff(args: {
  handoff: ServiceHandoff;
  error: string;
  getPairedTaskById?:
    | ((
        id: string,
      ) =>
        | Pick<PairedTask, 'id' | 'status' | 'round_trip_count' | 'updated_at'>
        | undefined)
    | undefined;
  enqueueMessageCheck?: ((chatJid: string) => void) | undefined;
}): void {
  failServiceHandoff(args.handoff.id, args.error);
  requeueFailedClaimedPairedTurn(args);
}

function resolveHandoffDeliveryChannel(args: {
  handoff: ServiceHandoff;
  handoffRole: PairedRoomRole;
  fallbackChannel: Channel;
  channels: Channel[];
  getPairedTaskById?:
    | ((
        id: string,
      ) =>
        | Pick<PairedTask, 'id' | 'status' | 'round_trip_count' | 'updated_at'>
        | undefined)
    | undefined;
  enqueueMessageCheck?: ((chatJid: string) => void) | undefined;
}): Channel | undefined {
  const { handoff, handoffRole } = args;
  if (handoffRole === 'owner') {
    return args.fallbackChannel;
  }

  const roleChannel = findChannelByName(
    args.channels,
    getFixedRoleChannelName(handoffRole),
  );
  if (!roleChannel) {
    failClaimedHandoff({
      handoff,
      error: getMissingRoleChannelMessage(handoffRole),
      getPairedTaskById: args.getPairedTaskById,
      enqueueMessageCheck: args.enqueueMessageCheck,
    });
    return undefined;
  }
  return roleChannel;
}

function buildHandoffPairedTurnIdentity(
  handoff: ServiceHandoff,
  handoffRole: PairedRoomRole,
) {
  if (
    !handoff.paired_task_id ||
    !handoff.paired_task_updated_at ||
    !handoff.turn_intent_kind
  ) {
    return undefined;
  }
  return buildPairedTurnIdentity({
    taskId: handoff.paired_task_id,
    taskUpdatedAt: handoff.paired_task_updated_at,
    intentKind: handoff.turn_intent_kind,
    role: handoff.turn_role ?? handoffRole,
    turnId: handoff.turn_id,
  });
}

export async function processClaimedHandoff(args: {
  handoff: ServiceHandoff;
  getRoomBindings: () => Record<string, RegisteredGroup>;
  channels: Channel[];
  executeTurn: ExecuteTurnFn;
  lastAgentTimestamps: Record<string, string>;
  saveState: () => void;
  getPairedTaskById?:
    | ((
        id: string,
      ) =>
        | Pick<PairedTask, 'id' | 'status' | 'round_trip_count' | 'updated_at'>
        | undefined)
    | undefined;
  enqueueMessageCheck?: ((chatJid: string) => void) | undefined;
}): Promise<void> {
  const { handoff } = args;
  const group = args.getRoomBindings()[handoff.chat_jid];
  if (!group) {
    failClaimedHandoff({
      handoff,
      error: 'Group not registered on target service',
      getPairedTaskById: args.getPairedTaskById,
      enqueueMessageCheck: args.enqueueMessageCheck,
    });
    return;
  }

  const channel = findChannel(args.channels, handoff.chat_jid);
  if (!channel) {
    failClaimedHandoff({
      handoff,
      error: 'No channel owns handoff jid',
      getPairedTaskById: args.getPairedTaskById,
      enqueueMessageCheck: args.enqueueMessageCheck,
    });
    return;
  }

  const handoffRole = resolveHandoffRoleOverride(handoff);
  if (!handoffRole) {
    failClaimedHandoff({
      handoff,
      error: 'Cannot resolve intended handoff role',
      getPairedTaskById: args.getPairedTaskById,
      enqueueMessageCheck: args.enqueueMessageCheck,
    });
    logger.error(
      {
        chatJid: handoff.chat_jid,
        handoffId: handoff.id,
        targetServiceId: handoff.target_service_id,
        targetRole: handoff.target_role ?? null,
        intendedRole: handoff.intended_role ?? null,
        reason: handoff.reason ?? null,
      },
      'Failed claimed service handoff because its intended role could not be resolved',
    );
    return;
  }
  if (handoff.turn_role && handoff.turn_role !== handoffRole) {
    failClaimedHandoff({
      handoff,
      error: `Stored handoff turn_role ${handoff.turn_role} conflicts with resolved role ${handoffRole}`,
      getPairedTaskById: args.getPairedTaskById,
      enqueueMessageCheck: args.enqueueMessageCheck,
    });
    logger.error(
      {
        chatJid: handoff.chat_jid,
        handoffId: handoff.id,
        turnId: handoff.turn_id ?? null,
        turnRole: handoff.turn_role,
        resolvedRole: handoffRole,
        targetServiceId: handoff.target_service_id,
      },
      'Failed claimed service handoff because its persisted logical turn role conflicts with the resolved role',
    );
    return;
  }

  const handoffChannel = resolveHandoffDeliveryChannel({
    handoff,
    handoffRole,
    fallbackChannel: channel,
    channels: args.channels,
    getPairedTaskById: args.getPairedTaskById,
    enqueueMessageCheck: args.enqueueMessageCheck,
  });
  if (!handoffChannel) {
    return;
  }

  const runId = `handoff-${handoff.id}`;
  const pairedTurnIdentity = buildHandoffPairedTurnIdentity(
    handoff,
    handoffRole,
  );
  try {
    logger.info(
      {
        chatJid: handoff.chat_jid,
        handoffId: handoff.id,
        runId,
        turnId: pairedTurnIdentity?.turnId ?? handoff.turn_id ?? null,
        handoffRole,
        targetRole: handoff.target_role ?? null,
        targetServiceId: handoff.target_service_id,
        targetAgentType: handoff.target_agent_type,
        reason: handoff.reason,
        intendedRole: handoff.intended_role ?? null,
        channelName: handoffChannel.name,
      },
      'Dispatching claimed service handoff',
    );
    const result = await args.executeTurn({
      group,
      prompt: handoff.prompt,
      chatJid: handoff.chat_jid,
      runId,
      channel: handoffChannel,
      startSeq: handoff.start_seq,
      endSeq: handoff.end_seq,
      forcedRole: handoffRole,
      forcedAgentType: handoff.target_agent_type,
      pairedTurnIdentity,
    });

    if (!result.deliverySucceeded) {
      failClaimedHandoff({
        handoff,
        error: 'Handoff delivery failed',
        getPairedTaskById: args.getPairedTaskById,
        enqueueMessageCheck: args.enqueueMessageCheck,
      });
      return;
    }

    const cursorKey = resolveHandoffCursorKey(handoff.chat_jid, handoffRole);
    const appliedCursor = completeServiceHandoffAndAdvanceTargetCursor({
      id: handoff.id,
      chat_jid: handoff.chat_jid,
      cursor_key: cursorKey,
      end_seq: handoff.end_seq,
    });
    if (appliedCursor) {
      args.lastAgentTimestamps[cursorKey] = appliedCursor;
      args.saveState();
    }
    logger.info(
      {
        chatJid: handoff.chat_jid,
        handoffId: handoff.id,
        runId,
        outputStatus: result.outputStatus,
        visiblePhase: result.visiblePhase,
        appliedCursor,
        cursorKey:
          appliedCursor != null
            ? resolveHandoffCursorKey(handoff.chat_jid, handoffRole)
            : null,
      },
      'Completed claimed service handoff',
    );
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    failClaimedHandoff({
      handoff,
      error: errorMessage,
      getPairedTaskById: args.getPairedTaskById,
      enqueueMessageCheck: args.enqueueMessageCheck,
    });
    logger.error(
      { chatJid: handoff.chat_jid, handoffId: handoff.id, err },
      'Claimed service handoff failed',
    );
  }
}
