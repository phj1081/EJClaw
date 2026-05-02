import type {
  IpcMessageForwardResult,
  IpcMessagePayload,
} from './ipc-types.js';
import { normalizeAgentOutput } from './agent-protocol.js';
import type { RegisteredGroup } from './types.js';

export async function forwardAuthorizedIpcMessage(
  msg: IpcMessagePayload,
  sourceGroup: string,
  isMain: boolean,
  roomBindings: Record<string, RegisteredGroup>,
  sendMessage: (
    jid: string,
    text: string,
    senderRole?: string,
    runId?: string,
    attachments?: import('./types.js').OutboundAttachment[],
  ) => Promise<void>,
  injectInboundMessage?: (payload: {
    chatJid: string;
    text: string;
    sender?: string;
    senderName?: string;
    messageId?: string;
    timestamp?: string;
    treatAsHuman: boolean;
    sourceKind?: import('./types.js').MessageSourceKind;
  }) => Promise<void>,
): Promise<IpcMessageForwardResult> {
  if (
    !(
      (msg.type === 'message' || msg.type === 'inject_inbound_message') &&
      msg.chatJid &&
      msg.text
    )
  ) {
    return { outcome: 'ignored', senderRole: msg.senderRole ?? null };
  }

  const targetGroup = roomBindings[msg.chatJid];
  const isMainOverride = isMain === true;
  if (
    !(isMainOverride || (targetGroup && targetGroup.folder === sourceGroup))
  ) {
    return {
      outcome: 'blocked',
      chatJid: msg.chatJid,
      targetGroup: targetGroup?.folder ?? null,
      isMainOverride,
      senderRole: msg.senderRole ?? null,
    };
  }

  if (msg.type === 'inject_inbound_message') {
    if (!injectInboundMessage) {
      return {
        outcome: 'ignored',
        chatJid: msg.chatJid,
        targetGroup: targetGroup?.folder ?? null,
        isMainOverride,
        senderRole: msg.senderRole ?? null,
      };
    }
    await injectInboundMessage({
      chatJid: msg.chatJid,
      text: msg.text,
      sender: msg.sender,
      senderName: msg.senderName,
      messageId: msg.messageId,
      timestamp: msg.timestamp,
      treatAsHuman: msg.treatAsHuman === true,
      sourceKind: msg.sourceKind,
    });
    return {
      outcome: 'sent',
      chatJid: msg.chatJid,
      targetGroup: targetGroup?.folder ?? null,
      isMainOverride,
      senderRole: msg.senderRole ?? null,
    };
  }

  const normalized = normalizeAgentOutput(msg.text);
  if (normalized.output?.visibility === 'silent') {
    return {
      outcome: 'sent',
      chatJid: msg.chatJid,
      targetGroup: targetGroup?.folder ?? null,
      isMainOverride,
      senderRole: msg.senderRole ?? null,
    };
  }
  const structured =
    normalized.output?.visibility === 'public' ? normalized.output : null;
  const text = structured?.text ?? normalized.result ?? msg.text;
  const attachments =
    msg.attachments && msg.attachments.length > 0
      ? msg.attachments
      : (structured?.attachments ?? undefined);

  await sendMessage(msg.chatJid, text, msg.senderRole, msg.runId, attachments);
  return {
    outcome: 'sent',
    chatJid: msg.chatJid,
    targetGroup: targetGroup?.folder ?? null,
    isMainOverride,
    senderRole: msg.senderRole ?? null,
  };
}
