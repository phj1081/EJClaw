import { type AgentOutput } from './agent-runner.js';
import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import { shouldResetSessionOnAgentFailure } from './session-recovery.js';
import { TASK_STATUS_MESSAGE_PREFIX } from './task-watch-status.js';
import { type Channel, type RegisteredGroup } from './types.js';

export type VisiblePhase = 'silent' | 'progress' | 'final';

interface MessageTurnControllerOptions {
  chatJid: string;
  group: RegisteredGroup;
  runId: string;
  channel: Channel;
  idleTimeout: number;
  failureFinalText: string;
  isClaudeCodeAgent: boolean;
  clearSession: () => void;
  requestClose: (reason: string) => void;
  deliverFinalText: (text: string) => Promise<boolean>;
}

export class MessageTurnController {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private visiblePhase: VisiblePhase = 'silent';
  private hadError = false;
  private producedDeliverySucceeded = true;
  private latestProgressText: string | null = null;
  private previousProgressText: string | null = null;
  private pendingProgressText: string | null = null;
  private toolActivities: string[] = [];
  private progressCreating = false;
  private latestProgressRendered: string | null = null;
  private progressMessageId: string | null = null;
  private progressStartedAt: number | null = null;
  private progressTicker: ReturnType<typeof setInterval> | null = null;
  private progressEditFailCount = 0;
  private latestProgressTextForFinal: string | null = null;
  private poisonedSessionDetected = false;
  private closeRequested = false;

  constructor(private readonly options: MessageTurnControllerOptions) {}

  async start(): Promise<void> {
    this.resetIdleTimer();
    await this.options.channel.setTyping?.(this.options.chatJid, true);
  }

  async handleOutput(result: AgentOutput): Promise<void> {
    if (this.terminalObserved()) {
      logger.info(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          resultStatus: result.status,
          resultPhase: result.phase,
        },
        'Discarding late agent output after terminal final',
      );
      return;
    }

    if (
      this.options.isClaudeCodeAgent &&
      shouldResetSessionOnAgentFailure(result) &&
      !this.poisonedSessionDetected
    ) {
      this.poisonedSessionDetected = true;
      this.hadError = true;
      this.options.clearSession();
      this.requestAgentClose('poisoned-session-detected');
      logger.warn(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
        },
        'Detected poisoned Claude session from streamed output, forcing close',
      );
    }

    const raw =
      result.result === null || result.result === undefined
        ? null
        : typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
    const text = raw ? formatOutbound(raw) : null;

    if (raw) {
      logger.info(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          resultStatus: result.status,
          resultPhase: result.phase,
          progressMessageId: this.progressMessageId,
        },
        `Agent output: ${raw.slice(0, 200)}`,
      );
    }

    if (result.phase === 'tool-activity') {
      // Ensure a progress message exists for tool activity sub-lines
      if (!this.progressMessageId && !this.progressCreating) {
        this.progressCreating = true;
        const heading = this.pendingProgressText || '작업 중...';
        this.sendProgressMessage(heading).then(() => {
          this.progressCreating = false;
          this.ensureProgressTicker();
          // Replay any queued tool activities now that the message exists
          if (this.toolActivities.length > 0 && this.progressMessageId) {
            void this.syncTrackedProgressMessage();
          }
        });
        this.pendingProgressText = null;
      }
      if (text) {
        this.addToolActivity(text);
      }
      if (!this.poisonedSessionDetected) {
        this.resetIdleTimer();
      }
      return;
    }

    if (result.phase === 'progress') {
      if (text) {
        if (this.progressMessageId) {
          // Progress message already visible — update heading directly
          this.previousProgressText = this.latestProgressText;
          this.latestProgressText = text;
          this.toolActivities = [];
          void this.syncTrackedProgressMessage();
        } else {
          this.bufferProgress(text);
        }
      }
      if (!this.poisonedSessionDetected) {
        this.resetIdleTimer();
      }
      if (result.status === 'error') {
        this.hadError = true;
      }
      return;
    }

    // Final arrived — flush any buffered progress that isn't the same text,
    // then discard the pending buffer so it never shows up.
    if (text) {
      await this.flushPendingProgress(text);
      // If the displayed progress heading matches the final text,
      // revert to the previous heading so it doesn't show twice.
      if (
        this.latestProgressText === text &&
        this.previousProgressText &&
        this.progressMessageId &&
        this.options.channel.editMessage
      ) {
        this.latestProgressText = this.previousProgressText;
        this.toolActivities = [];
        await this.syncTrackedProgressMessage();
      }
      await this.finalizeProgressMessage();
      await this.deliverFinalText(text);
    } else if (raw) {
      logger.info(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          resultStatus: result.status,
          resultPhase: result.phase,
          progressMessageId: this.progressMessageId,
        },
        'Agent output became empty after formatting; resetting tracked progress state',
      );
      await this.finalizeProgressMessage();
      this.latestProgressTextForFinal = null;
    } else {
      await this.finalizeProgressMessage();
    }

    await this.options.channel.setTyping?.(this.options.chatJid, false);
    if (result.status === 'success' && !this.poisonedSessionDetected) {
      this.requestAgentClose('output-delivered-close');
    }

    if (result.status === 'error') {
      this.hadError = true;
    }
  }

  async finish(outputStatus: 'success' | 'error'): Promise<{
    deliverySucceeded: boolean;
    visiblePhase: VisiblePhase;
  }> {
    await this.options.channel.setTyping?.(this.options.chatJid, false);

    if (outputStatus === 'error') {
      this.hadError = true;
    }

    if (
      outputStatus === 'success' &&
      this.visiblePhase === 'progress' &&
      !this.hadError &&
      this.latestProgressTextForFinal
    ) {
      logger.info(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
        },
        'Sending a separate final message from the last progress output after agent completion',
      );
      await this.finalizeProgressMessage();
      await this.deliverFinalText(this.latestProgressTextForFinal);
    } else if (
      this.visiblePhase === 'progress' &&
      !this.terminalObserved() &&
      this.hadError
    ) {
      await this.publishFailureFinal();
    }

    this.clearProgressTicker();
    if (this.idleTimer) clearTimeout(this.idleTimer);

    return {
      deliverySucceeded: this.producedDeliverySucceeded,
      visiblePhase: this.visiblePhase,
    };
  }

  private hasVisibleOutput(): boolean {
    return this.visiblePhase !== 'silent';
  }

  private terminalObserved(): boolean {
    return this.visiblePhase === 'final';
  }

  private renderProgressMessage(text: string): string {
    const elapsedSeconds =
      this.progressStartedAt === null
        ? 0
        : Math.floor((Date.now() - this.progressStartedAt) / 5_000) * 5;
    const hours = Math.floor(elapsedSeconds / 3600);
    const minutes = Math.floor((elapsedSeconds % 3600) / 60);
    const seconds = elapsedSeconds % 60;
    const elapsedParts: string[] = [];

    if (hours > 0) elapsedParts.push(`${hours}시간`);
    if (minutes > 0) elapsedParts.push(`${minutes}분`);
    elapsedParts.push(`${seconds}초`);

    const activityLines =
      this.toolActivities.length > 0
        ? '\n' +
          this.toolActivities
            .map((a, i) => {
              const isLast = i === this.toolActivities.length - 1;
              const connector = isLast ? '└' : '├';
              const isSummary = a.startsWith('📋');
              return isSummary ? `${connector} ${a}` : `${connector}  ${a}`;
            })
            .join('\n')
        : '';
    const suffix = `\n\n${elapsedParts.join(' ')}`;
    const maxText =
      2000 -
      TASK_STATUS_MESSAGE_PREFIX.length -
      activityLines.length -
      suffix.length;
    const truncated =
      text.length > maxText ? text.slice(0, maxText - 1) + '…' : text;
    return `${TASK_STATUS_MESSAGE_PREFIX}${truncated}${activityLines}${suffix}`;
  }

  private clearProgressTicker(): void {
    if (!this.progressTicker) return;
    clearInterval(this.progressTicker);
    this.progressTicker = null;
  }

  private resetProgressState(): void {
    this.clearProgressTicker();
    this.pendingProgressText = null;
    this.progressCreating = false;
    this.toolActivities = [];
    this.latestProgressText = null;
    this.previousProgressText = null;
    this.latestProgressRendered = null;
    this.progressMessageId = null;
    this.progressStartedAt = null;
    this.progressEditFailCount = 0;
  }

  /**
   * Buffer a progress update. The previous pending text gets flushed
   * immediately, and the new text waits until the next event arrives.
   * If a final result arrives before another progress, the pending
   * text is discarded — so it never shows up in Discord.
   */
  private bufferProgress(text: string): void {
    if (this.pendingProgressText) {
      void this.sendProgressMessage(this.pendingProgressText);
      this.toolActivities = [];
    }
    this.pendingProgressText = text;
  }

  /**
   * Append a tool activity line and update the progress message in-place.
   */
  private addToolActivity(description: string): void {
    const MAX_ACTIVITIES = 2;
    this.toolActivities.push(description);
    if (this.toolActivities.length > MAX_ACTIVITIES) {
      this.toolActivities = this.toolActivities.slice(-MAX_ACTIVITIES);
    }
    // Don't sync here — let the ticker handle periodic updates
    // to avoid flooding Discord with edits.
    this.ensureProgressTicker();
  }

  /**
   * Flush pending progress before a final result, but only if the
   * pending text differs from the final text.
   */
  private async flushPendingProgress(finalText: string): Promise<void> {
    if (this.pendingProgressText && this.pendingProgressText !== finalText) {
      await this.sendProgressMessage(this.pendingProgressText);
    }
    this.pendingProgressText = null;
  }

  private async syncTrackedProgressMessage(): Promise<void> {
    if (
      !this.progressMessageId ||
      !this.options.channel.editMessage ||
      !this.latestProgressText
    ) {
      return;
    }

    const rendered = this.renderProgressMessage(this.latestProgressText);

    try {
      await this.options.channel.editMessage(
        this.options.chatJid,
        this.progressMessageId,
        rendered,
      );
      this.latestProgressRendered = rendered;
      this.progressEditFailCount = 0;
    } catch (err) {
      this.progressEditFailCount++;
      logger.warn(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          progressMessageId: this.progressMessageId,
          progressEditFailCount: this.progressEditFailCount,
          err,
        },
        'Failed to edit tracked progress message; will retry before recreating',
      );
      this.latestProgressRendered = null;
      if (this.progressEditFailCount >= 3) {
        this.clearProgressTicker();
      }
    }
  }

  private ensureProgressTicker(): void {
    if (this.progressTicker || !this.options.channel.editMessage) {
      return;
    }

    this.progressTicker = setInterval(() => {
      if (
        this.progressMessageId &&
        this.latestProgressText &&
        !this.progressCreating
      ) {
        void this.syncTrackedProgressMessage();
      }
    }, 5_000);
  }

  private async finalizeProgressMessage(): Promise<void> {
    logger.info(
      {
        chatJid: this.options.chatJid,
        group: this.options.group.name,
        groupFolder: this.options.group.folder,
        runId: this.options.runId,
        progressMessageId: this.progressMessageId,
        latestProgressText: this.latestProgressText,
      },
      'Finalizing tracked progress message',
    );
    await this.syncTrackedProgressMessage();
    this.resetProgressState();
  }

  private async deliverFinalText(text: string): Promise<void> {
    this.visiblePhase = 'final';
    const delivered = await this.options.deliverFinalText(text);
    if (!delivered) {
      this.producedDeliverySucceeded = false;
    }
    this.latestProgressTextForFinal = null;
  }

  private async publishFailureFinal(): Promise<void> {
    if (this.terminalObserved()) {
      return;
    }
    await this.finalizeProgressMessage();
    await this.deliverFinalText(this.options.failureFinalText);
  }

  private requestAgentClose(reason: string): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.options.requestClose(reason);
  }

  private async sendProgressMessage(text: string): Promise<void> {
    if (!text || (text === this.latestProgressText && this.progressMessageId)) {
      return;
    }

    if (this.progressStartedAt === null) {
      this.progressStartedAt = Date.now();
    }
    this.latestProgressTextForFinal = text;
    this.previousProgressText = this.latestProgressText;
    this.latestProgressText = text;
    const rendered = this.renderProgressMessage(text);

    if (this.progressMessageId && this.options.channel.editMessage) {
      logger.info(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          progressMessageId: this.progressMessageId,
          text,
        },
        'Updating tracked progress message',
      );
      await this.syncTrackedProgressMessage();
      this.visiblePhase = 'progress';
      return;
    }

    if (!this.options.channel.sendAndTrack) {
      this.latestProgressRendered = rendered;
      await this.options.channel.sendMessage(this.options.chatJid, rendered);
      this.visiblePhase = 'progress';
      return;
    }

    try {
      this.progressMessageId = await this.options.channel.sendAndTrack(
        this.options.chatJid,
        rendered,
      );
    } catch (err) {
      logger.warn(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          err,
        },
        'Failed to send tracked progress message',
      );
      this.latestProgressRendered = rendered;
      await this.options.channel.sendMessage(this.options.chatJid, rendered);
      this.visiblePhase = 'progress';
      return;
    }

    if (this.progressMessageId) {
      logger.info(
        {
          chatJid: this.options.chatJid,
          group: this.options.group.name,
          groupFolder: this.options.group.folder,
          runId: this.options.runId,
          progressMessageId: this.progressMessageId,
          text,
        },
        'Created tracked progress message',
      );
      this.latestProgressRendered = rendered;
      this.ensureProgressTicker();
      this.visiblePhase = 'progress';
      return;
    }

    this.latestProgressRendered = rendered;
    await this.options.channel.sendMessage(this.options.chatJid, rendered);
    this.visiblePhase = 'progress';
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hasVisibleOutput()) {
      this.idleTimer = null;
      return;
    }

    this.idleTimer = setTimeout(() => {
      logger.debug(
        {
          group: this.options.group.name,
          chatJid: this.options.chatJid,
          runId: this.options.runId,
        },
        'Idle timeout, closing agent stdin',
      );
      this.requestAgentClose('idle-timeout');
    }, this.options.idleTimeout);
  }
}
