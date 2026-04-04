export interface SendMessageIpcPayloadInput {
  chatJid: string;
  text: string;
  sender?: string;
  senderRole?: string;
  groupFolder: string;
  timestamp?: string;
}

export function buildSendMessageIpcPayload(
  input: SendMessageIpcPayloadInput,
): Record<string, string | undefined> {
  return {
    type: 'message',
    chatJid: input.chatJid,
    text: input.text,
    sender: input.sender || undefined,
    senderRole: input.senderRole || undefined,
    groupFolder: input.groupFolder,
    timestamp: input.timestamp || new Date().toISOString(),
  };
}
