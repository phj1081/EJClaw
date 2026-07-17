import { isReplyableMessageId } from "./bridge-utils";

export interface ProgressBeforeTypingInput<T> {
  startProgress: () => Promise<void>;
  sendTyping: () => Promise<T>;
  onTypingError: (error: unknown) => void;
}

export async function startProgressBeforeTyping<T>(input: ProgressBeforeTypingInput<T>): Promise<T | null> {
  await input.startProgress();
  try {
    return await input.sendTyping();
  } catch (error) {
    input.onTypingError(error);
    return null;
  }
}

export function progressReplyMessageId(jobMessageId: string, steeringMessageId: string | null): string | null {
  if (steeringMessageId && isReplyableMessageId(steeringMessageId)) return steeringMessageId;
  return isReplyableMessageId(jobMessageId) ? jobMessageId : null;
}

export async function recoverMissingSteeringProgress(
  progressMessageId: string | null,
  recover: () => Promise<void>,
): Promise<boolean> {
  if (progressMessageId) return false;
  await recover();
  return true;
}
