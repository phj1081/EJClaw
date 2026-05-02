import { createProducedWorkItem } from './db.js';
import type { WorkItem } from './db/work-items.js';
import { resolveRuntimeAttachmentBaseDirs } from './attachment-base-dirs.js';
import { deliverOpenWorkItem } from './message-runtime-delivery.js';
import { parseVisibleVerdict } from './paired-verdict.js';
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

export interface CanonicalOutboundDeliveryArgs {
  jid: string;
  text: string;
  deliveryRole?: PairedRoomRole;
  attachments?: OutboundAttachment[];
}

export interface CanonicalOutboundDeliveryDeps {
  channels: Channel[];
  roomBindings: () => Record<string, RegisteredGroup>;
  log?: IpcDeliveryLog;
  createWorkItem?: typeof createProducedWorkItem;
  deliverWorkItem?: typeof deliverOpenWorkItem;
}

export type CanonicalOutboundDeliveryResult = 'delivered' | 'queued_retry';

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

export async function deliverCanonicalOutboundMessage(
  args: CanonicalOutboundDeliveryArgs,
  deps: CanonicalOutboundDeliveryDeps,
): Promise<CanonicalOutboundDeliveryResult> {
  const log = deps.log ?? logger;
  const group = deps.roomBindings()[args.jid];
  if (!group) {
    throw new Error(`No registered room binding for outbound JID: ${args.jid}`);
  }

  const route = resolveChannelForDeliveryRole(
    deps.channels,
    args.jid,
    args.deliveryRole,
  );
  if (!route.channel) throw new Error(`No channel for JID: ${args.jid}`);

  log.info(
    {
      transition: 'outbound:route',
      chatJid: args.jid,
      deliveryRole: args.deliveryRole ?? null,
      requestedRoleChannel: route.requestedRoleChannelName,
      selectedChannel: route.selectedChannelName,
      usedRoleChannel: route.usedRoleChannel,
      fallbackUsed: route.fallbackUsed,
    },
    'Routed outbound message to canonical work item delivery',
  );

  const createWorkItem = deps.createWorkItem ?? createProducedWorkItem;
  const workItem = createWorkItem({
    group_folder: group.folder,
    chat_jid: args.jid,
    agent_type: group.agentType ?? 'claude-code',
    delivery_role: args.deliveryRole ?? null,
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
    attachmentBaseDirs: resolveRuntimeAttachmentBaseDirs(group),
    isDuplicateOfLastBotFinal: () => false,
    openContinuation: () => {},
  });

  return delivered ? 'delivered' : 'queued_retry';
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

  log.info(
    {
      transition: 'ipc:route',
      chatJid: args.jid,
      runId: args.runId ?? null,
      senderRole: deliveryRole ?? null,
    },
    'IPC relay routed message to canonical work item delivery',
  );

  const result = await deliverCanonicalOutboundMessage(
    {
      jid: args.jid,
      text: args.text,
      deliveryRole,
      attachments: args.attachments,
    },
    {
      channels: deps.channels,
      roomBindings: deps.roomBindings,
      log,
      createWorkItem: deps.createWorkItem,
      deliverWorkItem: deps.deliverWorkItem,
    },
  );

  if (result !== 'delivered') {
    return result;
  }

  if (
    (deliveryRole === 'reviewer' || deliveryRole === 'arbiter') &&
    isTerminalStatusMessage(args.text)
  ) {
    deps.queue.noteDirectTerminalDelivery?.(args.jid, deliveryRole, args.text);
  }
  return 'delivered';
}
