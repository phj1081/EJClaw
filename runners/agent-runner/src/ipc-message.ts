import {
  normalizeAgentOutput,
  type RunnerOutputAttachment,
} from 'ejclaw-runners-shared';

export interface SendMessageIpcPayloadInput {
  chatJid: string;
  text: string;
  sender?: string;
  senderRole?: string;
  runId?: string;
  groupFolder: string;
  timestamp?: string;
}

export interface SendMessageIpcPayload {
  type: 'message';
  chatJid: string;
  text: string;
  sender?: string;
  senderRole?: string;
  runId?: string;
  groupFolder: string;
  timestamp: string;
  attachments?: RunnerOutputAttachment[];
}

export function buildSendMessageIpcPayload(
  input: SendMessageIpcPayloadInput,
): SendMessageIpcPayload {
  const normalized = normalizeAgentOutput(input.text);
  const output =
    normalized.output?.visibility === 'public' ? normalized.output : null;
  const text = output?.text ?? normalized.result ?? '';
  const attachments = output?.attachments ?? [];

  return {
    type: 'message',
    chatJid: input.chatJid,
    text,
    sender: input.sender || undefined,
    senderRole: input.senderRole || undefined,
    runId: input.runId || undefined,
    groupFolder: input.groupFolder,
    timestamp: input.timestamp || new Date().toISOString(),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}
