import { createProducedWorkItem } from './db.js';
import type { WorkItem } from './db/work-items.js';
import { deliverOpenWorkItem } from './message-runtime-delivery.js';
import { parseVisibleVerdict } from './paired-execution-context-shared.js';
import { resolveChannelForDeliveryRole } from './router.js';
import type {
  Channel,
  OutboundAttachment,
  PairedRoomRole,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';

type IpcDeliveryLog = Pick<typeof logger, 'info' | 'warn' | 'error'>;

interface IpcOutboundQueue {
  hasRecordedDirectTerminalDeliveryForRun?(
    groupJid: string,
    runId: string,
    senderRole?: string | null,
  ): boolean;
  noteDirectTerminalDelivery?(
    groupJid: string,
    senderRole?: string | null,
    text?: string | null,
  ): void;
}

export interface IpcOutboundDeliveryArgs {
  jid: string;
  text: string;
  senderRole?: string;
  runId?: string;
  attachments?: OutboundAttachment[];
}

export interface IpcOutboundDeliveryDeps {
  channels: Channel[];
  roomBindings: () => Record<string, RegisteredGroup>;
  queue: IpcOutboundQueue;
  log?: IpcDeliveryLog;
  createWorkItem?: typeof createProducedWorkItem;
  deliverWorkItem?: typeof deliverOpenWorkItem;
}

export type IpcOutboundDeliveryResult =
  | 'delivered'
  | 'queued_retry'
  | 'skipped_recorded_terminal';

function normalizeDeliveryRole(
  senderRole: string | undefined,
): PairedRoomRole | undefined {
  if (
    senderRole === 'owner' ||
    senderRole === 'reviewer' ||
    senderRole === 'arbiter'
  ) {
    return senderRole;
  }
  return undefined;
}

function isTerminalStatusMessage(text: string): boolean {
  return parseVisibleVerdict(text) !== 'continue';
}

export async function deliverIpcOutboundMessage(
  args: IpcOutboundDeliveryArgs,
  deps: IpcOutboundDeliveryDeps,
): Promise<IpcOutboundDeliveryResult> {
  const log = deps.log ?? logger;
  const deliveryRole = normalizeDeliveryRole(args.senderRole);
  if (
    args.runId &&
    (deliveryRole === 'reviewer' || deliveryRole === 'arbiter') &&
    deps.queue.hasRecordedDirectTerminalDeliveryForRun?.(
      args.jid,
      args.runId,
      deliveryRole,
    )
  ) {
    log.info(
      {
        transition: 'ipc:skip-post-terminal',
        chatJid: args.jid,
        senderRole: deliveryRole,
        runId: args.runId,
      },
      'Skipped IPC relay message because the run already emitted a direct terminal verdict',
    );
    return 'skipped_recorded_terminal';
  }

  const group = deps.roomBindings()[args.jid];
  if (!group) {
    throw new Error(
      `No registered room binding for IPC outbound JID: ${args.jid}`,
    );
  }

  const route = resolveChannelForDeliveryRole(
    deps.channels,
    args.jid,
    deliveryRole,
  );
  if (!route.channel) throw new Error(`No channel for JID: ${args.jid}`);

  log.info(
    {
      transition: 'ipc:route',
      chatJid: args.jid,
      runId: args.runId ?? null,
      senderRole: deliveryRole ?? null,
      requestedRoleChannel: route.requestedRoleChannelName,
      selectedChannel: route.selectedChannelName,
      usedRoleChannel: route.usedRoleChannel,
      fallbackUsed: route.fallbackUsed,
    },
    'IPC relay routed message to canonical work item delivery',
  );

  const createWorkItem = deps.createWorkItem ?? createProducedWorkItem;
  const workItem = createWorkItem({
    group_folder: group.folder,
    chat_jid: args.jid,
    agent_type: group.agentType ?? 'claude-code',
    delivery_role: deliveryRole ?? null,
    start_seq: null,
    end_seq: null,
    result_payload: args.text,
    attachments: args.attachments,
  });

  const deliverWorkItem = deps.deliverWorkItem ?? deliverOpenWorkItem;
  const delivered = await deliverWorkItem({
    channel: route.channel,
    item: workItem as WorkItem,
    log,
    attachmentBaseDirs: group.workDir ? [group.workDir] : undefined,
    isDuplicateOfLastBotFinal: () => false,
    openContinuation: () => {},
  });

  if (!delivered) {
    return 'queued_retry';
  }

  if (
    (deliveryRole === 'reviewer' || deliveryRole === 'arbiter') &&
    isTerminalStatusMessage(args.text)
  ) {
    deps.queue.noteDirectTerminalDelivery?.(args.jid, deliveryRole, args.text);
  }
  return 'delivered';
}
