import type {
  IpcMessageForwardResult,
  IpcMessagePayload,
} from './ipc-types.js';
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
  ) => Promise<void>,
): Promise<IpcMessageForwardResult> {
  if (!(msg.type === 'message' && msg.chatJid && msg.text)) {
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

  await sendMessage(msg.chatJid, msg.text, msg.senderRole, msg.runId);
  return {
    outcome: 'sent',
    chatJid: msg.chatJid,
    targetGroup: targetGroup?.folder ?? null,
    isMainOverride,
    senderRole: msg.senderRole ?? null,
  };
}
