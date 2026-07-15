export const PROGRESS_AFTER_MS = 30_000;

export function progressCleanupFallbackText(): string {
  return "최종 응답 전송됨";
}

export class ProgressLifecycle {
  private progressMessageId: string | null;

  constructor(input: { startedAt: number; existingMessageId: string | null }) {
    this.startedAt = input.startedAt;
    this.progressMessageId = input.existingMessageId;
  }

  private readonly startedAt: number;

  existingMessageId(): string | null {
    return this.progressMessageId;
  }

  messageId(): string | null {
    return this.progressMessageId;
  }

  delayUntilVisible(now = Date.now()): number {
    if (this.progressMessageId) return 0;
    return Math.max(0, this.startedAt + PROGRESS_AFTER_MS - now);
  }

  isDue(now = Date.now()): boolean {
    return this.delayUntilVisible(now) === 0;
  }

  recordPosted(messageId: string): void {
    this.progressMessageId = messageId;
  }

  takeCleanupAfterFinalDelivery(): string | null {
    const messageId = this.progressMessageId;
    this.progressMessageId = null;
    return messageId;
  }
}
