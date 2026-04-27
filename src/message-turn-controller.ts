import { type AgentOutput } from './agent-runner.js';
import {
  getAgentOutputAttachments,
  getAgentOutputText,
} from './agent-output.js';
import { createScopedLogger, logger } from './logger.js';
import { formatOutbound } from './router.js';
import { shouldResetSessionOnAgentFailure } from './session-recovery.js';
import { TASK_STATUS_MESSAGE_PREFIX } from './task-watch-status.js';
import { formatElapsedKorean } from './utils.js';
import type { PairedTurnIdentity } from './paired-turn-identity.js';
import {
  normalizeAgentOutputPhase,
  toVisiblePhase,
  type AgentOutputPhase,
  type Channel,
  type OutboundAttachment,
  type PairedRoomRole,
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
  deliverFinalText: (
    text: string,
    options?: {
      attachments?: OutboundAttachment[];
      replaceMessageId?: string | null;
    },
  ) => Promise<boolean>;
  canDeliverFinalText?: () => boolean;
  allowProgressReplayWithoutFinal?: boolean;
  deliveryRole?: PairedRoomRole | null;
  deliveryServiceId?: string | null;
  pairedTurnIdentity?: PairedTurnIdentity | null;
  recordTurnProgress?: (turnId: string, progressText: string) => void;
}

export class MessageTurnController {
  private readonly log: typeof logger;
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

  constructor(private readonly options: MessageTurnControllerOptions) {
    this.log = createScopedLogger({
      chatJid: options.chatJid,
      groupName: options.group.name,
      groupFolder: options.group.folder,
      runId: options.runId,
    });
  }

  private buildOutboundAuditContext(
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const outboundMeta = this.options.channel.getOutboundAuditMeta?.();
    return {
      chatJid: this.options.chatJid,
      runId: this.options.runId,
      deliveryRole:
        this.options.deliveryRole ??
        this.options.pairedTurnIdentity?.role ??
        null,
      serviceId: this.options.deliveryServiceId ?? null,
      turnId: this.options.pairedTurnIdentity?.turnId ?? null,
      turnRole: this.options.pairedTurnIdentity?.role ?? null,
      intentKind: this.options.pairedTurnIdentity?.intentKind ?? null,
      channelName: outboundMeta?.channelName ?? this.options.channel.name,
      botUserId: outboundMeta?.botUserId ?? null,
      botUsername: outboundMeta?.botUsername ?? null,
      ...extra,
    };
  }

  private logOutboundAudit(
    auditEvent: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.log.info(
      this.buildOutboundAuditContext({
        auditEvent,
        ...extra,
      }),
      'Outbound message audit',
    );
  }

  private async setTyping(
    isTyping: boolean,
    source: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    this.log.debug(
      {
        transition: isTyping ? 'typing:on' : 'typing:off',
        source,
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
      this.log.info(
        {
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
      this.log.warn(
        'Detected poisoned Claude session from streamed output, forcing close',
      );
    }

    const raw = getAgentOutputText(result);
    const text = raw ? formatOutbound(raw) : null;
    const attachments = getAgentOutputAttachments(result);

    if (raw) {
      this.log.info(
        {
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
            this.pendingProgressText = null; // discard stale buffer
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
      await this.publishTerminalText(text, {
        attachments,
        flushPendingText: text,
      });
    } else if (raw) {
      this.log.info(
        {
          resultStatus: result.status,
          resultPhase: result.phase,
          progressMessageId: this.progressMessageId,
        },
        'Agent output became empty after formatting; resetting tracked progress state',
      );
      await this.finalizeProgressMessage();
      this.latestProgressTextForFinal = null;
    } else {
      this.log.info(
        {
          resultStatus: result.status,
          resultPhase: result.phase,
          progressMessageId: this.progressMessageId,
          latestProgressTextForFinal: this.latestProgressTextForFinal,
        },
        'Received a final output with no visible text; deferring any progress replay to finish()',
      );
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
      const replayText = this.latestProgressTextForFinal;
      if (this.options.allowProgressReplayWithoutFinal !== false) {
        this.log.info(
          'Sending a separate final message from the last progress output after agent completion',
        );
        await this.publishTerminalText(replayText);
      } else {
        await this.finalizeProgressMessage();
        this.log.info(
          'Skipped replaying the last progress output as a final message for this turn',
        );
        this.latestProgressTextForFinal = null;
      }
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

  private composeProgressBody(text: string): string {
    if (this.subagents.size > 1) {
      const lines: string[] = [];
      for (const [, track] of this.subagents) {
        const latest = track.activities[track.activities.length - 1];
        lines.push(latest ? `${track.label} · ${latest}` : track.label);
      }
      return lines.join('\n');
    }
    if (this.subagents.size === 1) {
      const [, track] = this.subagents.entries().next().value!;
      const lines: string[] = [track.label];
      for (let i = 0; i < track.activities.length; i++) {
        const isLast = i === track.activities.length - 1;
        lines.push(`${isLast ? '└' : '├'}  ${track.activities[i]}`);
      }
      return lines.join('\n');
    }
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
    return text + activityLines;
  }

  private persistProgressBody(body: string): void {
    const turnId = this.options.pairedTurnIdentity?.turnId;
    if (!turnId || !this.options.recordTurnProgress) return;
    try {
      this.options.recordTurnProgress(turnId, body);
    } catch (err) {
      this.log.warn(
        { err, turnId, bodyLength: body.length },
        'Failed to persist progress body',
      );
    }
  }

  private renderProgressMessage(text: string): string {
    const elapsedMs =
      this.progressStartedAt === null
        ? 0
        : Math.floor((Date.now() - this.progressStartedAt) / 5_000) * 5000;

    const suffix = `\n\n${formatElapsedKorean(elapsedMs)}`;
    const body = this.composeProgressBody(text);

    this.persistProgressBody(body);

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
    const turnId = this.options.pairedTurnIdentity?.turnId;
    if (turnId && this.options.recordTurnProgress) {
      try {
        this.options.recordTurnProgress(turnId, '');
      } catch {
        /* clearing progress is best-effort */
      }
    }
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
    if (
      this.options.canDeliverFinalText &&
      !this.options.canDeliverFinalText()
    ) {
      this.log.info(
        {
          runId: this.options.runId,
          deliveryRole: this.options.deliveryRole ?? null,
          turnId: this.options.pairedTurnIdentity?.turnId ?? null,
          pendingLength: this.pendingProgressText?.length ?? 0,
          finalLength: finalText.length,
        },
        'Skipped flushing pending progress because this run no longer owns the active paired turn attempt',
      );
      this.pendingProgressText = null;
      return;
    }

    if (
      this.pendingProgressText &&
      (this.options.pairedTurnIdentity?.role === 'reviewer' ||
        this.options.pairedTurnIdentity?.role === 'arbiter')
    ) {
      this.log.info(
        {
          runId: this.options.runId,
          deliveryRole: this.options.deliveryRole ?? null,
          turnId: this.options.pairedTurnIdentity?.turnId ?? null,
          pendingLength: this.pendingProgressText.length,
          finalLength: finalText.length,
        },
        'Skipped flushing pending progress before final delivery for reviewer/arbiter turn',
      );
      this.pendingProgressText = null;
      return;
    }

    if (this.pendingProgressText && this.pendingProgressText !== finalText) {
      await this.sendProgressMessage(this.pendingProgressText);
    }
    this.pendingProgressText = null;
  }

  private async syncTrackedProgressMessage(): Promise<void> {
    if (
      this.options.canDeliverFinalText &&
      !this.options.canDeliverFinalText()
    ) {
      this.log.info(
        {
          runId: this.options.runId,
          deliveryRole: this.options.deliveryRole ?? null,
          turnId: this.options.pairedTurnIdentity?.turnId ?? null,
          progressMessageId: this.progressMessageId,
          latestProgressLength: this.latestProgressText?.length ?? 0,
        },
        'Skipped editing tracked progress because this run no longer owns the active paired turn attempt',
      );
      return;
    }

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
      this.logOutboundAudit('progress-edit', {
        messageId: this.progressMessageId,
        textLength: this.latestProgressText.length,
        renderedLength: rendered.length,
      });
    } catch (err) {
      this.progressEditFailCount++;
      this.log.warn(
        {
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
    this.log.info(
      {
        progressMessageId: this.progressMessageId,
        latestProgressText: this.latestProgressText,
      },
      'Finalizing tracked progress message',
    );
    await this.syncTrackedProgressMessage();
    this.resetProgressState();
  }

  private async publishTerminalText(
    text: string,
    options?: {
      attachments?: OutboundAttachment[];
      flushPendingText?: string | null;
    },
  ): Promise<void> {
    if (options?.flushPendingText) {
      await this.flushPendingProgress(options.flushPendingText);
    }

    const hasAttachments = (options?.attachments?.length ?? 0) > 0;
    const replaceMessageId = hasAttachments
      ? this.discardProgressForAttachmentFinalDelivery()
      : this.consumeProgressForFinalDelivery();
    await this.deliverFinalText(text, {
      ...(options?.attachments?.length
        ? { attachments: options.attachments }
        : {}),
      replaceMessageId,
    });
  }

  private consumeProgressForFinalDelivery(): string | null {
    const replaceMessageId = this.progressMessageId;
    this.log.info(
      {
        progressMessageId: replaceMessageId,
        latestProgressText: this.latestProgressText,
      },
      replaceMessageId
        ? 'Promoting tracked progress message to final delivery'
        : 'Delivering final output without a tracked progress message to replace',
    );
    this.resetProgressState();
    return replaceMessageId;
  }

  private discardProgressForAttachmentFinalDelivery(): null {
    this.log.info(
      {
        progressMessageId: this.progressMessageId,
        latestProgressText: this.latestProgressText,
      },
      this.progressMessageId
        ? 'Discarding tracked progress replacement for final attachment delivery'
        : 'Delivering final attachment output without a tracked progress message to replace',
    );
    this.resetProgressState();
    return null;
  }

  private async deliverFinalText(
    text: string,
    options?: {
      attachments?: OutboundAttachment[];
      replaceMessageId?: string | null;
    },
  ): Promise<void> {
    await this.activateTyping('turn:deliver-final');
    this.visiblePhase = toVisiblePhase('final');
    const replaceMessageId = options?.replaceMessageId ?? null;
    if (
      this.options.canDeliverFinalText &&
      !this.options.canDeliverFinalText()
    ) {
      this.log.info(
        {
          runId: this.options.runId,
          deliveryRole: this.options.deliveryRole ?? null,
          turnId: this.options.pairedTurnIdentity?.turnId ?? null,
          textLength: text.length,
        },
        'Suppressed final delivery because this run no longer owns the active paired turn attempt',
      );
      this.latestProgressTextForFinal = null;
      return;
    }
    this.logOutboundAudit('final-delivery-attempt', {
      attachmentCount: options?.attachments?.length ?? 0,
      messageId: replaceMessageId,
      textLength: text.length,
      deliveryMode: replaceMessageId ? 'edit' : 'send',
    });
    const delivered = await this.options.deliverFinalText(text, {
      ...(options?.attachments?.length
        ? { attachments: options.attachments }
        : {}),
      replaceMessageId,
    });
    this.logOutboundAudit('final-delivery-result', {
      attachmentCount: options?.attachments?.length ?? 0,
      messageId: replaceMessageId,
      textLength: text.length,
      deliveryMode: replaceMessageId ? 'edit' : 'send',
      delivered,
    });
    if (!delivered) {
      this.producedDeliverySucceeded = false;
    }
    this.latestProgressTextForFinal = null;
  }

  private async publishFailureFinal(): Promise<void> {
    if (this.terminalObserved()) {
      return;
    }
    await this.publishTerminalText(this.options.failureFinalText);
  }

  private requestAgentClose(reason: string): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.options.requestClose(reason);
  }

  private async sendProgressMessage(text: string): Promise<void> {
    if (
      this.options.canDeliverFinalText &&
      !this.options.canDeliverFinalText()
    ) {
      this.log.info(
        {
          runId: this.options.runId,
          deliveryRole: this.options.deliveryRole ?? null,
          turnId: this.options.pairedTurnIdentity?.turnId ?? null,
          progressMessageId: this.progressMessageId,
          textLength: text.length,
        },
        'Skipped progress delivery because this run no longer owns the active paired turn attempt',
      );
      this.pendingProgressText = null;
      return;
    }

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
      this.log.info(
        {
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
      this.logOutboundAudit('progress-fallback-send', {
        messageId: null,
        tracked: false,
        textLength: text.length,
        renderedLength: rendered.length,
      });
      this.visiblePhase = toVisiblePhase('progress');
      return;
    }

    try {
      this.progressMessageId = await this.options.channel.sendAndTrack(
        this.options.chatJid,
        rendered,
      );
    } catch (err) {
      this.log.warn({ err }, 'Failed to send tracked progress message');
      this.latestProgressRendered = rendered;
      await this.options.channel.sendMessage(this.options.chatJid, rendered);
      this.logOutboundAudit('progress-fallback-send', {
        messageId: null,
        tracked: false,
        fallbackReason: 'tracked-send-error',
        textLength: text.length,
        renderedLength: rendered.length,
      });
      this.visiblePhase = toVisiblePhase('progress');
      return;
    }

    if (this.progressMessageId) {
      this.log.info(
        {
          progressMessageId: this.progressMessageId,
          text,
        },
        'Created tracked progress message',
      );
      this.latestProgressRendered = rendered;
      this.logOutboundAudit('progress-create', {
        messageId: this.progressMessageId,
        tracked: true,
        textLength: text.length,
        renderedLength: rendered.length,
      });
      this.ensureProgressTicker();
      this.visiblePhase = toVisiblePhase('progress');
      return;
    }

    this.latestProgressRendered = rendered;
    await this.options.channel.sendMessage(this.options.chatJid, rendered);
    this.logOutboundAudit('progress-fallback-send', {
      messageId: null,
      tracked: false,
      fallbackReason: 'tracked-send-returned-null',
      textLength: text.length,
      renderedLength: rendered.length,
    });
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
      this.log.debug(
        {
          idleTimeoutMs: this.options.idleTimeout,
        },
        'Idle timeout, closing agent stdin',
      );
      this.requestAgentClose('idle-timeout');
    }, this.options.idleTimeout);
  }
}
