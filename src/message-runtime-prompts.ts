import { buildArbiterContextPrompt } from './arbiter-context.js';
import { formatMessages } from './router.js';
import type { NewMessage, PairedTask, PairedTurnOutput } from './types.js';

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
  return [...humanMessages, ...turnOutputsToMessages(turnOutputs, chatJid)].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp),
  );
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

  const humanMessages = args.missedMessages.filter((message) => !message.is_bot_message);
  return formatMessages(
    mergeHumanAndTurnOutputMessages(
      args.chatJid,
      humanMessages,
      args.turnOutputs,
    ),
    args.timezone,
  );
}

export function buildReviewerPendingPrompt(args: {
  chatJid: string;
  timezone: string;
  turnOutputs: PairedTurnOutput[];
  recentHumanMessages: NewMessage[];
  lastHumanMessage: string | null | undefined;
}): string {
  if (args.turnOutputs.length > 0) {
    return formatMessages(
      mergeHumanAndTurnOutputMessages(
        args.chatJid,
        args.recentHumanMessages,
        args.turnOutputs,
      ),
      args.timezone,
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
}): string {
  if (args.turnOutputs.length > 0) {
    return formatMessages(
      mergeHumanAndTurnOutputMessages(
        args.chatJid,
        args.recentHumanMessages,
        args.turnOutputs,
      ),
      args.timezone,
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

  return `The reviewer approved your work (DONE). Finalize and report the result.${reviewerSummary}`;
}
