export interface SendMessageIpcPayloadInput {
  chatJid: string;
  text: string;
  sender?: string;
  senderRole?: string;
  runId?: string;
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
    runId: input.runId || undefined,
    groupFolder: input.groupFolder,
    timestamp: input.timestamp || new Date().toISOString(),
  };
}
