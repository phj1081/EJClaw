import {
  getLatestOpenPairedTaskForChat,
  hasActiveCiWatcherForChat,
} from './db.js';
import { logger } from './logger.js';
import { enqueuePairedFollowUpAfterEvent } from './message-runtime-follow-up.js';
import type { PairedRoomRole } from './types.js';

export async function handleMessageRuntimeAfterDeliverySuccess(args: {
  chatJid: string;
  runId: string;
  deliveryRole: PairedRoomRole | null;
  pairedRoom: boolean;
  enqueueMessageCheck: (chatJid: string) => void;
}): Promise<void> {
  if (!args.deliveryRole || !args.pairedRoom) {
    return;
  }

  const pendingTaskAfterDelivery = getLatestOpenPairedTaskForChat(args.chatJid);
  if (
    args.deliveryRole === 'owner' &&
    pendingTaskAfterDelivery?.status === 'review_ready' &&
    hasActiveCiWatcherForChat(args.chatJid)
  ) {
    logger.info(
      {
        chatJid: args.chatJid,
        runId: args.runId,
        completedRole: args.deliveryRole,
        taskId: pendingTaskAfterDelivery.id,
        taskStatus: pendingTaskAfterDelivery.status,
      },
      'Deferred paired follow-up after successful owner delivery because CI watcher is still active',
    );
    return;
  }

  const followUpResult = enqueuePairedFollowUpAfterEvent({
    chatJid: args.chatJid,
    runId: args.runId,
    task: pendingTaskAfterDelivery,
    source: 'delivery-success',
    completedRole: args.deliveryRole,
    fallbackLastTurnOutputRole: args.deliveryRole,
    enqueueMessageCheck: () => args.enqueueMessageCheck(args.chatJid),
  });
  if (followUpResult.kind === 'paired-follow-up') {
    logger.info(
      {
        chatJid: args.chatJid,
        runId: args.runId,
        completedRole: args.deliveryRole,
        taskId: followUpResult.taskId,
        taskStatus: followUpResult.taskStatus,
        intentKind: followUpResult.intentKind,
        scheduled: followUpResult.scheduled,
      },
      followUpResult.scheduled
        ? args.deliveryRole === 'owner'
          ? 'Queued paired follow-up after successful owner delivery'
          : 'Queued paired follow-up after successful reviewer/arbiter delivery'
        : args.deliveryRole === 'owner'
          ? 'Skipped duplicate paired follow-up after successful owner delivery while task state was unchanged'
          : 'Skipped duplicate paired follow-up after successful reviewer/arbiter delivery while task state was unchanged',
    );
  }
}
