import { type AgentOutput } from './agent-runner.js';
import { getAgentOutputText } from './agent-output.js';
import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import { shouldResetSessionOnAgentFailure } from './session-recovery.js';
import { TASK_STATUS_MESSAGE_PREFIX } from './task-watch-status.js';
import { formatElapsedKorean } from './utils.js';
import {
  normalizeAgentOutputPhase,
  toVisiblePhase,
  type AgentOutputPhase,
  type Channel,
  type RegisteredGroup,
  type VisiblePhase,
} from './types.js';

export type { VisiblePhase };

interface SubagentTrack {
  label: string;
  activities: string[];
}

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
  private subagents = new Map<string, SubagentTrack>();
  private lastIntermediateText: string | null = null;
  private poisonedSessionDetected = false;
  private closeRequested = false;
  private typingActive = false;

  constructor(private readonly options: MessageTurnControllerOptions) {}

  private async setTyping(
    isTyping: boolean,
    source: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    logger.debug(
      {
        transition: isTyping ? 'typing:on' : 'typing:off',
        source,
        chatJid: this.options.chatJid,
        group: this.options.group.name,
        groupFolder: this.options.group.folder,
        runId: this.options.runId,
        ...extra,
      },
      'Typing indicator transition',
    );
    await this.options.channel.setTyping?.(this.options.chatJid, isTyping);
  }

  async start(): Promise<void> {
    this.resetIdleTimer();
    await this.activateTyping('turn:start');
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

    const raw = getAgentOutputText(result);
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

    const phase: AgentOutputPhase = normalizeAgentOutputPhase(result.phase);

    switch (phase) {
      case 'intermediate':
        if (text) {
          if (this.progressMessageId) {
            // Progress exists — update heading (works with or without subagents)
            this.previousProgressText = this.latestProgressText;
            this.latestProgressText = text;
            this.latestProgressTextForFinal = text;
            this.toolActivities = [];
            void this.syncTrackedProgressMessage();
          } else {
            // No progress yet — buffer (creates on next event)
            this.bufferProgress(text);
          }
        }
        if (!this.poisonedSessionDetected) {
          this.resetIdleTimer();
        }
        return;

      case 'tool-activity':
        if (result.agentId) {
          // Subagent tool activity
          let track = this.subagents.get(result.agentId);
          if (!track) {
            track = { label: '작업 중...', activities: [] };
            this.subagents.set(result.agentId, track);
          }
          if (text) {
            const MAX = 2;
            track.activities.push(text);
            if (track.activities.length > MAX) {
              track.activities = track.activities.slice(-MAX);
            }
          }
          this.ensureProgressMessageExists();
          this.ensureProgressTicker();
          if (!this.poisonedSessionDetected) {
            this.resetIdleTimer();
          }
          return;
        }
        // Main agent tool activity
        this.ensureProgressMessageExists();
        if (text) {
          this.addToolActivity(text);
        }
        if (!this.poisonedSessionDetected) {
          this.resetIdleTimer();
        }
        return;

      case 'progress':
        if (result.agentId) {
          if (result.agentDone) {
            const done = this.subagents.get(result.agentId);
            if (done) {
              done.label = done.label.replace('🔄', '✅');
              done.activities = [];
            }
          } else {
            const label =
              text ||
              (result.agentLabel ? `🔄 ${result.agentLabel}` : '작업 중...');
            const existing = this.subagents.get(result.agentId);
            if (existing) {
              existing.label = label;
              existing.activities = [];
            } else {
              this.subagents.set(result.agentId, { label, activities: [] });
            }
          }
          if (!this.latestProgressText) {
            this.latestProgressText = '작업 중...';
            this.latestProgressTextForFinal = '작업 중...';
          }
          this.ensureProgressMessageExists();
          this.ensureProgressTicker();
          if (this.progressMessageId) {
            void this.syncTrackedProgressMessage();
          }
          if (!this.poisonedSessionDetected) {
            this.resetIdleTimer();
          }
          if (result.status === 'error') {
            this.hadError = true;
          }
          return;
        }
        // Main agent progress
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

      case 'final':
        break;

      default: {
        const exhaustive: never = phase;
        throw new Error(`Unhandled message turn phase: ${exhaustive}`);
      }
    }

    // Final arrived — flush any buffered progress that isn't the same text,
    // then discard the pending buffer so it never shows up.
    if (text) {
      await this.flushPendingProgress(text);
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

    await this.deactivateTyping('turn:handle-output', {
      outputStatus: result.status,
      phase,
    });
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
    await this.deactivateTyping('turn:finish', { outputStatus });

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
    const elapsedMs =
      this.progressStartedAt === null
        ? 0
        : Math.floor((Date.now() - this.progressStartedAt) / 5_000) * 5000;

    const suffix = `\n\n${formatElapsedKorean(elapsedMs)}`;
    let body: string;

    if (this.subagents.size > 1) {
      // Compact: one line per subagent with latest activity
      const lines: string[] = [];
      for (const [, track] of this.subagents) {
        const latest = track.activities[track.activities.length - 1];
        lines.push(latest ? `${track.label} · ${latest}` : track.label);
      }
      body = lines.join('\n');
    } else if (this.subagents.size === 1) {
      // Single subagent: detailed view with activity sub-lines
      const [, track] = this.subagents.entries().next().value!;
      const lines: string[] = [track.label];
      for (let i = 0; i < track.activities.length; i++) {
        const isLast = i === track.activities.length - 1;
        lines.push(`${isLast ? '└' : '├'}  ${track.activities[i]}`);
      }
      body = lines.join('\n');
    } else {
      // Single agent rendering
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
      body = text + activityLines;
    }

    const maxBody = 2000 - TASK_STATUS_MESSAGE_PREFIX.length - suffix.length;
    const truncated =
      body.length > maxBody ? body.slice(0, maxBody - 1) + '…' : body;
    return `${TASK_STATUS_MESSAGE_PREFIX}${truncated}${suffix}`;
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
    this.subagents.clear();
    this.latestProgressText = null;
    this.previousProgressText = null;
    this.latestProgressRendered = null;
    this.progressMessageId = null;
    this.progressStartedAt = null;
    this.progressEditFailCount = 0;
  }

  /**
   * Ensure a progress message exists in Discord.
   * Creates one if needed, using pending or default text.
   */
  private ensureProgressMessageExists(): void {
    if (this.progressMessageId || this.progressCreating) return;
    this.progressCreating = true;
    const heading =
      this.pendingProgressText || this.latestProgressText || '작업 중...';
    if (!this.latestProgressText) {
      this.latestProgressText = heading;
      this.latestProgressTextForFinal = heading;
    }
    void this.sendProgressMessage(heading).then(() => {
      this.progressCreating = false;
      this.ensureProgressTicker();
      if (
        (this.toolActivities.length > 0 || this.subagents.size > 0) &&
        this.progressMessageId
      ) {
        void this.syncTrackedProgressMessage();
      }
    });
    this.pendingProgressText = null;
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
    await this.activateTyping('turn:deliver-final');
    this.visiblePhase = toVisiblePhase('final');
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

    await this.activateTyping('turn:send-progress');

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
      this.visiblePhase = toVisiblePhase('progress');
      return;
    }

    if (!this.options.channel.sendAndTrack) {
      this.latestProgressRendered = rendered;
      await this.options.channel.sendMessage(this.options.chatJid, rendered);
      this.visiblePhase = toVisiblePhase('progress');
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
      this.visiblePhase = toVisiblePhase('progress');
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
      this.visiblePhase = toVisiblePhase('progress');
      return;
    }

    this.latestProgressRendered = rendered;
    await this.options.channel.sendMessage(this.options.chatJid, rendered);
    this.visiblePhase = toVisiblePhase('progress');
  }

  private async activateTyping(
    source: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    if (this.typingActive) return;
    await this.setTyping(true, source, extra);
    this.typingActive = true;
  }

  private async deactivateTyping(
    source: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.typingActive) return;
    await this.setTyping(false, source, extra);
    this.typingActive = false;
  }

  cancelPendingTypingDelay(): void {
    // No-op: typing delay removed. Kept for call-site compatibility.
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
