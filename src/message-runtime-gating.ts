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

  return { handled: false };
}
