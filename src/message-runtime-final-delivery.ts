import { createProducedWorkItem } from './db.js';
import { resolveRuntimeAttachmentBaseDirs } from './attachment-base-dirs.js';
import { logger } from './logger.js';
import { deliverOpenWorkItem } from './message-runtime-delivery.js';
import type {
  AgentType,
  Channel,
  OutboundAttachment,
  PairedRoomRole,
  RegisteredGroup,
} from './types.js';

export async function deliverMessageRuntimeFinalText(args: {
  text: string;
  attachments?: OutboundAttachment[];
  chatJid: string;
  runId: string;
  channel: Channel;
  group: RegisteredGroup;
  startSeq: number | null;
  endSeq: number | null;
  forcedAgentType?: AgentType;
  deliveryRole: PairedRoomRole | null;
  deliveryServiceId: string | null;
  replaceMessageId?: string | null;
  hasDirectTerminalDeliveryForRun?: (
    chatJid: string,
    runId: string,
    deliveryRole: PairedRoomRole | null,
  ) => boolean;
  isDuplicateOfLastBotFinal: (chatJid: string, text: string) => boolean;
  openContinuation: (chatJid: string) => void;
}): Promise<boolean> {
  if (
    (args.deliveryRole === 'reviewer' || args.deliveryRole === 'arbiter') &&
    args.hasDirectTerminalDeliveryForRun?.(
      args.chatJid,
      args.runId,
      args.deliveryRole,
    )
  ) {
    logger.info(
      {
        chatJid: args.chatJid,
        runId: args.runId,
        deliveryRole: args.deliveryRole,
      },
      'Skipping final work item delivery because this run already sent a direct terminal IPC message',
    );
    return true;
  }

  const workItem = createProducedWorkItem({
    group_folder: args.group.folder,
    chat_jid: args.chatJid,
    agent_type: args.forcedAgentType ?? args.group.agentType ?? 'claude-code',
    service_id: args.deliveryServiceId ?? undefined,
    delivery_role: args.deliveryRole,
    start_seq: args.startSeq,
    end_seq: args.endSeq,
    result_payload: args.text,
    attachments: args.attachments,
  });

  return deliverOpenWorkItem({
    channel: args.channel,
    item: workItem,
    log: logger,
    attachmentBaseDirs: resolveRuntimeAttachmentBaseDirs(args.group),
    replaceMessageId: args.replaceMessageId,
    isDuplicateOfLastBotFinal: args.isDuplicateOfLastBotFinal,
    openContinuation: args.openContinuation,
  });
}
