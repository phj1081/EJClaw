import { buildArbiterContextPrompt } from './arbiter-context.js';
import { formatMessages } from './router.js';
import type {
  NewMessage,
  OutboundAttachment,
  PairedTask,
  PairedTurnOutput,
} from './types.js';

const CARRIED_FORWARD_OWNER_FINAL_MARKER =
  '[Carried forward context from the previous task: latest owner final]';

const CARRIED_FORWARD_OWNER_FINAL_GUIDANCE = `System note:
If you see a message beginning with "${CARRIED_FORWARD_OWNER_FINAL_MARKER}", treat it as background only. Do not repeat, continue, or answer that carried-forward final directly. Respond only to the latest human request and the current task.`;

const ARBITER_TURN_OUTPUT_CONTEXT_LIMIT = 6;
const TASK_USER_CONTEXT_START_SKEW_MS = 5_000;

function isImageAttachment(attachment: OutboundAttachment): boolean {
  if (attachment.mime?.toLowerCase().startsWith('image/')) return true;
  return /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(attachment.path);
}

function attachmentLabel(attachment: OutboundAttachment): string {
  return attachment.name?.trim() || attachment.path.split('/').at(-1) || 'file';
}

function formatTurnOutputAttachmentContext(
  attachments: OutboundAttachment[] | undefined,
): string {
  if (!attachments?.length) return '';
  const lines = attachments.map((attachment) => {
    const label = attachmentLabel(attachment);
    return isImageAttachment(attachment)
      ? `[Image: ${label} → ${attachment.path}]`
      : `[Attachment: ${label} → ${attachment.path}]`;
  });
  return `\n\nAttached evidence from this turn:\n${lines.join('\n')}`;
}

function formatTurnOutputMessageContent(turnOutput: PairedTurnOutput): string {
  return `${turnOutput.output_text}${formatTurnOutputAttachmentContext(
    turnOutput.attachments,
  )}`;
}

function turnOutputsToMessages(
  outputs: PairedTurnOutput[],
  chatJid: string,
): NewMessage[] {
  return outputs.map((turnOutput) => ({
    id: `turn-${turnOutput.task_id}-${turnOutput.turn_number}`,
    chat_jid: chatJid,
    sender: turnOutput.role,
    sender_name: turnOutput.role,
    content: formatTurnOutputMessageContent(turnOutput),
    timestamp: turnOutput.created_at,
    is_bot_message: true as const,
    is_from_me: false as const,
  }));
}

function mergeHumanAndTurnOutputMessages(
  chatJid: string,
  humanMessages: NewMessage[],
  turnOutputs: PairedTurnOutput[],
): NewMessage[] {
  return [
    ...humanMessages,
    ...turnOutputsToMessages(turnOutputs, chatJid),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function latestTurnOutputs(
  outputs: PairedTurnOutput[],
  limit: number,
): PairedTurnOutput[] {
  if (outputs.length <= limit) {
    return outputs;
  }
  return outputs.slice(-limit);
}

function currentTaskHumanMessages(
  messages: NewMessage[],
  taskCreatedAt: string | null | undefined,
): NewMessage[] {
  if (!taskCreatedAt) return [];
  const taskStartMs = Date.parse(taskCreatedAt);
  if (!Number.isFinite(taskStartMs)) return [];
  return messages.filter((message) => {
    if (message.is_bot_message) return false;
    const messageMs = Date.parse(message.timestamp);
    return (
      Number.isFinite(messageMs) &&
      messageMs >= taskStartMs - TASK_USER_CONTEXT_START_SKEW_MS
    );
  });
}

function hasCarriedForwardOwnerFinal(outputs: PairedTurnOutput[]): boolean {
  return outputs.some((output) =>
    output.output_text.startsWith(CARRIED_FORWARD_OWNER_FINAL_MARKER),
  );
}

function prependCarriedForwardGuidance(
  prompt: string,
  turnOutputs: PairedTurnOutput[],
): string {
  if (!hasCarriedForwardOwnerFinal(turnOutputs)) {
    return prompt;
  }
  return `${CARRIED_FORWARD_OWNER_FINAL_GUIDANCE}\n\n${prompt}`;
}

export function buildPairedTurnPrompt(args: {
  taskId: string;
  chatJid: string;
  timezone: string;
  missedMessages: NewMessage[];
  labeledFallbackMessages: NewMessage[];
  turnOutputs: PairedTurnOutput[];
}): string {
  if (args.turnOutputs.length === 0) {
    return formatMessages(args.labeledFallbackMessages, args.timezone);
  }

  const humanMessages = args.missedMessages.filter(
    (message) => !message.is_bot_message,
  );
  return prependCarriedForwardGuidance(
    formatMessages(
      mergeHumanAndTurnOutputMessages(
        args.chatJid,
        humanMessages,
        args.turnOutputs,
      ),
      args.timezone,
    ),
    args.turnOutputs,
  );
}

function turnOutputsOnlyPrompt(
  chatJid: string,
  timezone: string,
  turnOutputs: PairedTurnOutput[],
  taskHumanMessages: NewMessage[] = [],
): string {
  return prependCarriedForwardGuidance(
    formatMessages(
      [...taskHumanMessages, ...turnOutputsToMessages(turnOutputs, chatJid)],
      timezone,
    ),
    turnOutputs,
  );
}

export function buildReviewerPendingPrompt(args: {
  chatJid: string;
  timezone: string;
  turnOutputs: PairedTurnOutput[];
  recentHumanMessages: NewMessage[];
  lastHumanMessage: string | null | undefined;
  taskCreatedAt?: string | null;
}): string {
  if (args.turnOutputs.length > 0) {
    return turnOutputsOnlyPrompt(
      args.chatJid,
      args.timezone,
      args.turnOutputs,
      currentTaskHumanMessages(args.recentHumanMessages, args.taskCreatedAt),
    );
  }

  if (!args.lastHumanMessage) {
    return 'Review the latest owner changes in the workspace.';
  }

  return `User request:\n---\n${args.lastHumanMessage}\n---\n\nReview the latest owner changes in the workspace.`;
}

export function buildOwnerPendingPrompt(args: {
  chatJid: string;
  timezone: string;
  turnOutputs: PairedTurnOutput[];
  recentHumanMessages: NewMessage[];
  lastHumanMessage: string | null | undefined;
  taskCreatedAt?: string | null;
}): string {
  if (args.turnOutputs.length > 0) {
    return turnOutputsOnlyPrompt(
      args.chatJid,
      args.timezone,
      args.turnOutputs,
      currentTaskHumanMessages(args.recentHumanMessages, args.taskCreatedAt),
    );
  }

  if (!args.lastHumanMessage) {
    return 'Continue the owner turn using the latest reviewer or arbiter feedback.';
  }

  return `User request:\n---\n${args.lastHumanMessage}\n---\n\nContinue the owner turn using the latest reviewer or arbiter feedback.`;
}

export function buildArbiterPromptForTask(args: {
  task: PairedTask;
  chatJid: string;
  timezone: string;
  turnOutputs: PairedTurnOutput[];
  recentMessages: NewMessage[];
  labeledRecentMessages: NewMessage[];
}): string {
  const taskHumanMessages = currentTaskHumanMessages(
    args.recentMessages,
    args.task.created_at,
  );
  const messages =
    args.turnOutputs.length > 0
      ? [
          ...taskHumanMessages,
          ...turnOutputsToMessages(
            latestTurnOutputs(
              args.turnOutputs,
              ARBITER_TURN_OUTPUT_CONTEXT_LIMIT,
            ),
            args.chatJid,
          ),
        ]
      : args.labeledRecentMessages;

  return buildArbiterContextPrompt({
    chatJid: args.chatJid,
    taskId: args.task.id,
    roundTripCount: args.task.round_trip_count,
    timezone: args.timezone,
    messages,
  });
}

export function buildFinalizePendingPrompt(_args: {
  turnOutputs: PairedTurnOutput[];
}): string {
  return `The reviewer approved the current task scope (TASK_DONE / legacy DONE). Finalize and report the result.
If you intend to close this paired turn now, your first line must be TASK_DONE.
Do not use STEP_DONE only because a broader roadmap still has remaining work; close the approved slice and continue the next slice in a new owner turn.
Use STEP_DONE only when this same approved scope still needs additional owner changes and another review pass.
If your first line is DONE_WITH_CONCERNS, the system will reopen review instead of finishing.`;
}
