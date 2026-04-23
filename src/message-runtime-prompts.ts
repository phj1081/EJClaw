import { buildArbiterContextPrompt } from './arbiter-context.js';
import { formatMessages } from './router.js';
import type { NewMessage, PairedTask, PairedTurnOutput } from './types.js';

const CARRIED_FORWARD_OWNER_FINAL_MARKER =
  '[Carried forward context from the previous task: latest owner final]';

const CARRIED_FORWARD_OWNER_FINAL_GUIDANCE = `System note:
If you see a message beginning with "${CARRIED_FORWARD_OWNER_FINAL_MARKER}", treat it as background only. Do not repeat, continue, or answer that carried-forward final directly. Respond only to the latest human request and the current task.`;

export interface PriorTaskPromptContext {
  ownerFinal?: string | null;
  reviewerFinal?: string | null;
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
    content: turnOutput.output_text,
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

function truncatePriorTaskFinal(text: string, maxChars = 1200): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function formatPriorTaskPromptContext(
  priorTaskContext?: PriorTaskPromptContext | null,
): string {
  if (!priorTaskContext) {
    return '';
  }

  const sections: string[] = [];
  if (priorTaskContext.ownerFinal?.trim()) {
    sections.push(
      `Previous task owner final:\n---\n${truncatePriorTaskFinal(priorTaskContext.ownerFinal)}\n---`,
    );
  }
  if (priorTaskContext.reviewerFinal?.trim()) {
    sections.push(
      `Previous task reviewer final:\n---\n${truncatePriorTaskFinal(priorTaskContext.reviewerFinal)}\n---`,
    );
  }

  if (sections.length === 0) {
    return '';
  }

  return `Background from the previous completed paired task:\n${sections.join('\n\n')}\n\n`;
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

export function buildReviewerPendingPrompt(args: {
  chatJid: string;
  timezone: string;
  turnOutputs: PairedTurnOutput[];
  recentHumanMessages: NewMessage[];
  lastHumanMessage: string | null | undefined;
  priorTaskContext?: PriorTaskPromptContext | null;
}): string {
  if (args.turnOutputs.length > 0) {
    return prependCarriedForwardGuidance(
      formatMessages(
        mergeHumanAndTurnOutputMessages(
          args.chatJid,
          args.recentHumanMessages,
          args.turnOutputs,
        ),
        args.timezone,
      ),
      args.turnOutputs,
    );
  }

  if (!args.lastHumanMessage) {
    return `${formatPriorTaskPromptContext(args.priorTaskContext)}Review the latest owner changes in the workspace.`;
  }

  return `${formatPriorTaskPromptContext(args.priorTaskContext)}User request:\n---\n${args.lastHumanMessage}\n---\n\nReview the latest owner changes in the workspace.`;
}

export function buildOwnerPendingPrompt(args: {
  chatJid: string;
  timezone: string;
  turnOutputs: PairedTurnOutput[];
  recentHumanMessages: NewMessage[];
  lastHumanMessage: string | null | undefined;
  priorTaskContext?: PriorTaskPromptContext | null;
}): string {
  if (args.turnOutputs.length > 0) {
    return prependCarriedForwardGuidance(
      formatMessages(
        mergeHumanAndTurnOutputMessages(
          args.chatJid,
          args.recentHumanMessages,
          args.turnOutputs,
        ),
        args.timezone,
      ),
      args.turnOutputs,
    );
  }

  if (!args.lastHumanMessage) {
    return `${formatPriorTaskPromptContext(args.priorTaskContext)}Continue the owner turn using the latest reviewer or arbiter feedback.`;
  }

  return `${formatPriorTaskPromptContext(args.priorTaskContext)}User request:\n---\n${args.lastHumanMessage}\n---\n\nContinue the owner turn using the latest reviewer or arbiter feedback.`;
}

export function buildArbiterPromptForTask(args: {
  task: PairedTask;
  chatJid: string;
  timezone: string;
  turnOutputs: PairedTurnOutput[];
  recentMessages: NewMessage[];
  labeledRecentMessages: NewMessage[];
}): string {
  const messages =
    args.turnOutputs.length > 0
      ? mergeHumanAndTurnOutputMessages(
          args.chatJid,
          args.recentMessages.filter((message) => !message.is_bot_message),
          args.turnOutputs,
        )
      : args.labeledRecentMessages;

  return buildArbiterContextPrompt({
    chatJid: args.chatJid,
    taskId: args.task.id,
    roundTripCount: args.task.round_trip_count,
    timezone: args.timezone,
    messages,
  });
}

export function buildFinalizePendingPrompt(args: {
  turnOutputs: PairedTurnOutput[];
}): string {
  const lastReviewerOutput = [...args.turnOutputs]
    .reverse()
    .find((output) => output.role === 'reviewer');
  const reviewerSummary = lastReviewerOutput?.output_text
    ? `\n\nReviewer's final assessment:\n${lastReviewerOutput.output_text.slice(0, 2000)}`
    : '';

  return `The reviewer approved the current task scope (TASK_DONE / legacy DONE). Finalize and report the result.
If you intend to close this paired turn now, your first line must be TASK_DONE.
If the original request still has remaining work and the owner flow should continue, your first line may be STEP_DONE.
If your first line is DONE_WITH_CONCERNS, the system will reopen review instead of finishing.${reviewerSummary}`;
}
