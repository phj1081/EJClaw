import { getErrorMessage } from './utils.js';
import {
  claimServiceHandoff,
  completeServiceHandoffAndAdvanceTargetCursor,
  failServiceHandoff,
  getAllPendingServiceHandoffs,
  type ServiceHandoff,
} from './db.js';
import { findChannel, findChannelByName } from './router.js';
import { logger } from './logger.js';
import {
  getFixedRoleChannelName,
  getMissingRoleChannelMessage,
  resolveHandoffCursorKey,
  resolveHandoffRoleOverride,
} from './message-runtime-shared.js';
import type { ExecuteTurnFn } from './message-runtime-types.js';
import type {
  Channel,
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
  for (const handoff of getAllPendingServiceHandoffs()) {
    if (!claimServiceHandoff(handoff.id)) {
      continue;
    }

    args.enqueueTask(handoff.chat_jid, `handoff:${handoff.id}`, async () => {
      await args.processClaimedHandoff(handoff);
    });
  }
}

export async function processClaimedHandoff(args: {
  handoff: ServiceHandoff;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  channels: Channel[];
  executeTurn: ExecuteTurnFn;
  lastAgentTimestamps: Record<string, string>;
  saveState: () => void;
}): Promise<void> {
  const { handoff } = args;
  const group = args.getRegisteredGroups()[handoff.chat_jid];
  if (!group) {
    failServiceHandoff(handoff.id, 'Group not registered on target service');
    return;
  }

  const channel = findChannel(args.channels, handoff.chat_jid);
  if (!channel) {
    failServiceHandoff(handoff.id, 'No channel owns handoff jid');
    return;
  }

  const handoffRole = resolveHandoffRoleOverride(handoff);
  let handoffChannel = channel;
  if (handoffRole === 'reviewer') {
    const reviewerChannel = findChannelByName(
      args.channels,
      getFixedRoleChannelName('reviewer'),
    );
    if (!reviewerChannel) {
      failServiceHandoff(handoff.id, getMissingRoleChannelMessage('reviewer'));
      return;
    }
    handoffChannel = reviewerChannel;
  } else if (handoffRole === 'arbiter') {
    const arbiterChannel = findChannelByName(
      args.channels,
      getFixedRoleChannelName('arbiter'),
    );
    if (!arbiterChannel) {
      failServiceHandoff(handoff.id, getMissingRoleChannelMessage('arbiter'));
      return;
    }
    handoffChannel = arbiterChannel;
  }

  const runId = `handoff-${handoff.id}`;
  try {
    logger.info(
      {
        chatJid: handoff.chat_jid,
        handoffId: handoff.id,
        runId,
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
    });

    if (!result.deliverySucceeded) {
      failServiceHandoff(handoff.id, 'Handoff delivery failed');
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
    failServiceHandoff(handoff.id, errorMessage);
    logger.error(
      { chatJid: handoff.chat_jid, handoffId: handoff.id, err },
      'Claimed service handoff failed',
    );
  }
}
