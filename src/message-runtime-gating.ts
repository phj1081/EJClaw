import { logger } from './logger.js';
import { hasAllowedTrigger } from './message-runtime-rules.js';
import {
  handleSessionCommand,
  type SessionCommandDeps,
} from './session-commands.js';
import type { NewMessage, RegisteredGroup } from './types.js';

export async function handleQueuedRunGates(args: {
  chatJid: string;
  group: RegisteredGroup;
  runId: string;
  missedMessages: NewMessage[];
  triggerPattern: RegExp;
  timezone: string;
  hasImplicitContinuationWindow: (
    chatJid: string,
    messages: NewMessage[],
  ) => boolean;
  sessionCommandDeps: SessionCommandDeps;
}): Promise<{ handled: true; success: boolean } | { handled: false }> {
  const cmdResult = await handleSessionCommand({
    missedMessages: args.missedMessages,
    isMainGroup: args.group.isMain === true,
    groupName: args.group.name,
    runId: args.runId,
    triggerPattern: args.triggerPattern,
    timezone: args.timezone,
    deps: args.sessionCommandDeps,
  });
  if (cmdResult.handled) {
    return cmdResult;
  }

  if (
    !hasAllowedTrigger({
      chatJid: args.chatJid,
      messages: args.missedMessages,
      group: args.group,
      triggerPattern: args.triggerPattern,
      hasImplicitContinuationWindow: args.hasImplicitContinuationWindow,
    })
  ) {
    logger.info(
      { chatJid: args.chatJid, group: args.group.name, runId: args.runId },
      'Skipping queued run because no allowed trigger was found',
    );
    return { handled: true, success: true };
  }

  return { handled: false };
}
