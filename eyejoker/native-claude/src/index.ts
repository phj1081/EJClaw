#!/usr/bin/env bun
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type GuildTextBasedChannel,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  appendDiscordContext,
  conversationKey,
  isReplyableMessageId,
  isSupportedMessageType,
  sanitizeAttachmentName,
  stripBotMention,
  type DiscordContextEntry,
} from "./bridge-utils";
import { loadConfig, resolveRoute } from "./config";
import { ClaudeSdkExecutor } from "./sdk-executor";
import { assertClaudeExecutableCompatibility } from "./sdk-compat";
import { buildFinalChunkOptions, formatFinalMessage, splitDiscordMessage } from "./protocol";
import { progressElapsedSeconds, workElapsedSeconds } from "./duration";
import { ProgressLifecycle, progressCleanupFallbackText } from "./progress-lifecycle";
import { cleanupExpiredAttachmentDirs } from "./attachment-cleanup";
import { writeBoundedResponse } from "./bounded-download";
import { extractOutboundArtifacts } from "./outbound-artifacts";
import { removeOutboundSpool, spoolOutboundArtifacts } from "./outbound-spool";
import { parseControlCommand } from "./control-commands";
import {
  parseQuestionButtonId,
  questionButtonId,
  questionNonce,
  QuestionBroker,
  renderAnsweredInteractiveQuestion,
  renderInteractiveQuestion,
} from "./interactive-control";
import { KeyedSerialQueue } from "./keyed-serial-queue";
import { ProgressEditGate } from "./progress-edit-cadence";
import { deliverPendingChunks } from "./final-delivery";
import { JobRuntime } from "./runtime";
import {
  StreamProgressAggregator,
  renderProgressCard,
  type ProgressEvent,
} from "./stream-progress";
import { StateStore } from "./store";
import { formatDiscordStatus, renderStatusSnapshot } from "./status-format";
import type { ClaudeExecution, JobRecord } from "./types";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const configPath = resolve(process.env.CLAUDE_NATIVE_CONFIG ?? join(home, ".config/claude-native/routes.json"));
const statePath = resolve(
  process.env.CLAUDE_NATIVE_STATE_DB ?? join(home, ".local/state/claude-native/state.sqlite"),
);
const stateDir = resolve(process.env.CLAUDE_NATIVE_STATE_DIR ?? join(home, ".local/state/claude-native"));
const discordStateDir = resolve(
  process.env.DISCORD_STATE_DIR ?? join(home, ".claude/channels/discord-native"),
);

function dotenvValue(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1 || trimmed.slice(0, index) !== key) continue;
    return trimmed.slice(index + 1).replace(/^["']|["']$/g, "");
  }
  return null;
}

const token = process.env.DISCORD_BOT_TOKEN ?? dotenvValue(join(discordStateDir, ".env"), "DISCORD_BOT_TOKEN");
if (!token) throw new Error("DISCORD_BOT_TOKEN is required");
if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required (API-key-only runtime)");
if (!process.env.ANTHROPIC_BASE_URL) throw new Error("ANTHROPIC_BASE_URL is required");

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
chmodSync(stateDir, 0o700);
const config = loadConfig(configPath);
const routes = new Map(config.routes.map((route) => [route.id, route]));
const allowedUsers = new Set(config.allowedUserIds);
const store = new StateStore(statePath);
const claudeExecutable = process.env.CLAUDE_NATIVE_CLAUDE_BIN ?? join(home, ".hermes/node/bin/claude");
assertClaudeExecutableCompatibility(claudeExecutable);
const executor = new ClaudeSdkExecutor({
  claudeExecutable,
  timeoutSeconds: config.jobTimeoutSeconds,
});
const typingTimers = new Map<string, ReturnType<typeof setInterval>>();
const progressBoards = new Map<string, ProgressBoard>();
const questionBroker = new QuestionBroker();
const messageLifecycleQueue = new KeyedSerialQueue();
const attachmentRoot = join(stateDir, "attachments");
const outboundRoot = join(stateDir, "outbound");
const attachmentTtlMs = 7 * 24 * 60 * 60 * 1_000;
let queuePoll: ReturnType<typeof setInterval> | null = null;
let attachmentCleanupTimer: ReturnType<typeof setInterval> | null = null;

function cleanupExpiredAttachments(): number {
  const active = store.listActive();
  const inboundDeleted = cleanupExpiredAttachmentDirs(attachmentRoot, {
    activePaths: active.flatMap((job) => job.attachmentPaths),
    ttlMs: attachmentTtlMs,
  });
  const outboundDeleted = cleanupExpiredAttachmentDirs(outboundRoot, {
    activePaths: active.flatMap((job) => job.deliveryFiles.map((file) => file.path)),
    ttlMs: attachmentTtlMs,
  });
  return inboundDeleted.length + outboundDeleted.length;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

async function textChannel(id: string): Promise<GuildTextBasedChannel> {
  const channel = await client.channels.fetch(id);
  if (!channel?.isTextBased() || channel.isDMBased()) throw new Error(`Discord channel is unavailable: ${id}`);
  return channel as GuildTextBasedChannel;
}

function questionComponents(interactionId: string, choices: string[]): ActionRowBuilder<ButtonBuilder>[] {
  if (choices.length === 0) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      choices.slice(0, 4).map((choice, index) =>
        new ButtonBuilder()
          .setCustomId(questionButtonId(interactionId, index))
          .setLabel(choice.slice(0, 80))
          .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
      ),
    ),
  ];
}

function steeringFallbackMessageId(kind: "add" | "edit" | "delete", messageId: string, content = ""): string {
  const digest = createHash("sha256").update(`${kind}:${messageId}:${content}`).digest("hex").slice(0, 24);
  return `steering-${kind}:${messageId}:${digest}`;
}

async function clearQuestionComponents(channelId: string, messageId: string): Promise<void> {
  const channel = await textChannel(channelId);
  const message = await channel.messages.fetch(messageId);
  await message.edit({ components: [], allowedMentions: { parse: [] } });
}

async function cleanupQuestionComponentsForJob(job: JobRecord): Promise<number> {
  let cleaned = 0;
  for (const interaction of store.listJobInteractions(job.id)) {
    if (interaction.status !== "orphaned" || !interaction.discordMessageId) continue;
    try {
      await clearQuestionComponents(job.channelId, interaction.discordMessageId);
      store.clearInteractionMessage(interaction.id);
      cleaned += 1;
    } catch (error) {
      console.warn(`orphaned question cleanup failed job=${job.id} interaction=${interaction.id}`, String(error));
    }
  }
  return cleaned;
}

async function cleanupOrphanedQuestionComponents(): Promise<number> {
  let cleaned = 0;
  for (const interaction of store.listOrphanedInteractionsWithMessages()) {
    const job = store.getJob(interaction.jobId);
    if (!job) continue;
    cleaned += await cleanupQuestionComponentsForJob(job);
  }
  return cleaned;
}

async function validateRouteChannels(): Promise<void> {
  if (!client.user) throw new Error("Discord client user is unavailable");
  const failures: string[] = [];
  for (const route of config.routes) {
    try {
      const channel = await textChannel(route.discordChannelId);
      const permissions = channel.permissionsFor(client.user);
      const required = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.AddReactions,
      ];
      if (!permissions || !required.every((permission) => permissions.has(permission))) {
        failures.push(`${route.id}: missing view/send/thread/history/attach/reaction permission`);
      }
    } catch (error) {
      failures.push(`${route.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`Discord route validation failed: ${failures.join("; ")}`);
  console.log(`discord routes validated count=${config.routes.length}`);
}

class ProgressBoard {
  private message: Message | null = null;
  private readonly editGate = new ProgressEditGate();
  private pending: ReturnType<typeof setTimeout> | null = null;
  private visibleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastCard = "";
  private latest = new StreamProgressAggregator();
  private readonly lifecycle: ProgressLifecycle;

  constructor(private job: JobRecord) {
    const startedAt = Date.parse(job.startedAt ?? job.createdAt);
    this.lifecycle = new ProgressLifecycle({
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      existingMessageId: job.progressMessageId,
    });
  }

  async start(): Promise<void> {
    if (this.closed || this.message || this.visibleTimer) return;
    if (this.lifecycle.existingMessageId() || this.lifecycle.isDue()) {
      await this.openCard();
      return;
    }
    this.visibleTimer = setTimeout(() => {
      this.visibleTimer = null;
      void this.openCard();
    }, this.lifecycle.delayUntilVisible());
    this.visibleTimer.unref?.();
  }

  private async openCard(): Promise<void> {
    if (this.closed || this.message) return;
    const channel = await textChannel(this.job.channelId);
    const content = this.render("running");
    const options: MessageCreateOptions = {
      content,
      allowedMentions: { parse: [] },
    };
    if (isReplyableMessageId(this.job.messageId)) {
      options.reply = { messageReference: this.job.messageId, failIfNotExists: false };
    }

    const existingMessageId = this.lifecycle.existingMessageId();
    let message: Message;
    if (existingMessageId) {
      try {
        const existing = await channel.messages.fetch(existingMessageId);
        message = await existing.edit({ content, allowedMentions: { parse: [] } });
      } catch {
        message = await channel.send(options);
      }
    } else {
      message = await channel.send(options);
    }
    this.message = message;
    this.lifecycle.recordPosted(message.id);
    this.lastCard = content;
    this.editGate.recordEdit();
    store.setProgress(this.job.id, message.id, content);
  }

  handleEvent(_event: ProgressEvent, aggregator: StreamProgressAggregator): void {
    if (this.closed) return;
    this.latest = aggregator;
    this.editGate.markDirty();
    void this.queueCardEdit();
  }

  resetAfterInteraction(toolUseId?: string): void {
    if (this.closed) return;
    this.latest.resetAfterInteraction(toolUseId);
    this.editGate.markDirty();
    void this.queueCardEdit();
  }

  private elapsedSeconds(): number {
    return progressElapsedSeconds(this.job.startedAt, this.job.createdAt);
  }

  private render(mode: "running" | "final" | "cancelled", ok = true): string {
    const snapshot = this.latest.snapshot();
    if (!snapshot.mainModel) snapshot.mainModel = routes.get(this.job.routeId)?.model ?? "";
    return renderProgressCard({
      routeId: this.job.routeId,
      attempt: this.job.attempts,
      maxAttempts: config.maxAttempts,
      elapsedSeconds: this.elapsedSeconds(),
      promptPreview: this.job.prompt,
      recoveryReason: this.job.recoveryReason,
      snapshot,
      mode,
      ok,
    });
  }

  private queueCardEdit(): void {
    if (this.closed || !this.message) return;
    const dueIn = this.editGate.scheduleDelay();
    if (dueIn === null) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.flushCard();
    }, dueIn);
    this.pending.unref?.();
  }

  private async flushCard(mode: "running" | "final" | "cancelled" = "running", ok = true): Promise<void> {
    if (!this.message) return;
    if (this.closed && mode === "running") return;
    if (!this.editGate.beginEdit()) return;

    const content = this.render(mode, ok);
    if (content === this.lastCard && mode === "running") {
      this.editGate.finishEdit(Date.now(), false);
      void this.queueCardEdit();
      return;
    }

    let committed = false;
    try {
      this.message = await this.message.edit({ content, allowedMentions: { parse: [] } });
      this.lastCard = content;
      store.setProgress(this.job.id, this.message.id, content);
      committed = true;
    } catch (error) {
      console.warn("progress card edit failed", this.job.id, String(error));
    } finally {
      this.editGate.finishEdit(Date.now(), committed);
      void this.queueCardEdit();
    }
  }

  async cleanupAfterFinalDelivery(): Promise<void> {
    this.stopTimers();
    this.closed = true;
    const messageId = this.lifecycle.takeCleanupAfterFinalDelivery();
    if (!messageId) return;

    try {
      const channel = await textChannel(this.job.channelId);
      const message = this.message ?? (await channel.messages.fetch(messageId));
      await message.delete();
      store.clearProgress(this.job.id);
      return;
    } catch (deleteError) {
      try {
        const channel = await textChannel(this.job.channelId);
        const message = this.message ?? (await channel.messages.fetch(messageId));
        await message.edit({ content: progressCleanupFallbackText(), allowedMentions: { parse: [] } });
        store.clearProgress(this.job.id);
      } catch (fallbackError) {
        console.warn(
          "progress cleanup failed",
          this.job.id,
          String(deleteError),
          String(fallbackError),
        );
      }
    }
  }

  async cancel(): Promise<void> {
    this.stopTimers();
    this.closed = true;
  }

  private stopTimers(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    if (this.visibleTimer) {
      clearTimeout(this.visibleTimer);
      this.visibleTimer = null;
    }
  }
}

async function startTyping(job: JobRecord): Promise<void> {
  stopTyping(job.id);
  const channel = await textChannel(job.channelId);
  await channel.sendTyping();
  const timer = setInterval(() => {
    void channel.sendTyping().catch((error) => console.warn("typing failed", job.routeId, String(error)));
  }, 8_000);
  timer.unref();
  typingTimers.set(job.id, timer);
  console.log(`job start id=${job.id} route=${job.routeId} attempt=${job.attempts}`);

  let board = progressBoards.get(job.id);
  if (!board) {
    board = new ProgressBoard(job);
    progressBoards.set(job.id, board);
  }
  await board.start();
}

function stopTyping(jobId: string): void {
  const timer = typingTimers.get(jobId);
  if (timer) clearInterval(timer);
  typingTimers.delete(jobId);
}

async function deliverFinal(job: JobRecord, execution: ClaudeExecution): Promise<void> {
  stopTyping(job.id);
  const elapsed = workElapsedSeconds(job.startedAt, job.createdAt);
  const routeModel = routes.get(job.routeId)?.model;
  const mainModel = execution.mainModel ?? job.mainModel ?? routeModel;
  const subagentModels = execution.subagentModels ?? job.subagentModels;
  const artifacts = extractOutboundArtifacts(execution.result);
  const deliveryFiles = job.deliveryChunks
    ? job.deliveryFiles
    : spoolOutboundArtifacts(job.id, artifacts.files, outboundRoot);
  const renderedChunks = splitDiscordMessage(
    formatFinalMessage(config.ownerId, execution.ok, artifacts.body, elapsed, mainModel, subagentModels),
  );
  const plan = store.prepareDelivery(job.id, renderedChunks, deliveryFiles);
  const channel = await textChannel(job.channelId);
  let recentForReconcile: Message[] | null = null;
  await deliverPendingChunks(
    job.id,
    plan,
    async (index, chunk, nonce, files) => {
      const options: MessageCreateOptions = {
        ...buildFinalChunkOptions(config.ownerId, chunk, index),
        nonce,
        enforceNonce: true,
        files: files.map((file) => ({ attachment: file.path, name: file.name })),
      };
      const sent = await channel.send(options);
      return sent.id;
    },
    async (index, messageId) => {
      store.markDeliveryChunk(job.id, index, messageId);
    },
    async (_index, nonce) => {
      if (!recentForReconcile) {
        const fetched = await channel.messages.fetch({ limit: 100, cache: false });
        recentForReconcile = [...fetched.values()];
      }
      return (
        recentForReconcile.find(
          (message) => message.author.id === client.user?.id && message.nonce !== null && String(message.nonce) === nonce,
        )?.id ?? null
      );
    },
  );

  // Match the old NanoClaw contract: a temporary card only disappears after
  // the real user-facing result has been accepted by Discord. Cleanup is
  // best-effort and must never cause a duplicate final delivery retry.
  const board = progressBoards.get(job.id) ?? (job.progressMessageId ? new ProgressBoard(job) : null);
  if (board) {
    await board.cleanupAfterFinalDelivery();
    progressBoards.delete(job.id);
  }
  removeOutboundSpool(job.id, outboundRoot);
  console.log(`job final id=${job.id} route=${job.routeId} ok=${execution.ok} elapsed=${elapsed}`);
}

async function cleanupTerminalProgress(): Promise<number> {
  const terminal = store.listTerminalProgress();
  for (const job of terminal) {
    await new ProgressBoard(job).cleanupAfterFinalDelivery();
  }
  return terminal.length;
}

const runtime = new JobRuntime({
  store,
  routes,
  executor: (request) => executor.run(request),
  onStart: startTyping,
  onProgress: (job, event, aggregator) => {
    const board = progressBoards.get(job.id);
    if (!board) return;
    board.handleEvent(event, aggregator);
  },
  onQuestion: async (job, question) => {
    const interaction = store.beginInteraction(job.id, job.conversationKey, question);
    if (interaction.status === "answered" && interaction.answer) {
      progressBoards.get(job.id)?.resetAfterInteraction(question.toolUseId);
      return interaction.answer;
    }
    const answer = await questionBroker.wait(job.id, job.conversationKey, question, async () => {
      if (interaction.discordMessageId) return interaction.discordMessageId;
      const channel = await textChannel(job.channelId);
      const nonce = questionNonce(interaction.id);
      const recent = await channel.messages.fetch({ limit: 100, cache: false });
      let message = [...recent.values()].find(
        (candidate) => candidate.author.id === client.user?.id && String(candidate.nonce ?? "") === nonce,
      );
      if (!message) {
        message = await channel.send({
          content: renderInteractiveQuestion(question),
          components: questionComponents(interaction.id, question.choices),
          allowedMentions: { parse: [] },
          nonce,
          enforceNonce: true,
        });
      }
      store.setInteractionMessage(interaction.id, message.id);
      if (store.getInteraction(interaction.id)?.status === "answered") {
        await message.edit({ components: [], allowedMentions: { parse: [] } }).catch((error) =>
          console.warn(`answered question cleanup failed id=${job.id}`, String(error)),
        );
        return message.id;
      }
      console.log(`job waiting for Discord answer id=${job.id} question_message=${message.id}`);
      return message.id;
    }, (value) => {
      store.answerInteraction(interaction.id, value);
    });
    progressBoards.get(job.id)?.resetAfterInteraction(question.toolUseId);
    return answer;
  },
  onFinal: async (job, execution) => {
    await deliverFinal(job, execution);
  },
  maxConcurrent: config.maxConcurrent,
  maxAttempts: config.maxAttempts,
});

async function downloadAttachments(messageId: string, attachments: Iterable<{
  name: string;
  size: number;
  url: string;
}>): Promise<{ paths: string[]; errors: string[] }> {
  const paths: string[] = [];
  const errors: string[] = [];
  const targetDir = join(attachmentRoot, messageId);
  for (const attachment of [...attachments].slice(0, 10)) {
    if (attachment.size > 25 * 1024 * 1024) {
      errors.push(`${attachment.name}: 25MB 초과`);
      continue;
    }
    try {
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      const response = await fetch(attachment.url);
      const path = join(targetDir, sanitizeAttachmentName(attachment.name));
      await writeBoundedResponse(response, path, 25 * 1024 * 1024);
      paths.push(path);
    } catch (error) {
      errors.push(`${attachment.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { paths, errors };
}

async function discordContextFor(
  message: Message<true>,
  includeHistory: boolean,
): Promise<{ reply: DiscordContextEntry | null; history: DiscordContextEntry[] }> {
  const toEntry = (item: Message): DiscordContextEntry => ({
    id: item.id,
    author:
      item.author.id === client.user?.id
        ? "Claude"
        : (item.member?.displayName ?? item.author.globalName ?? item.author.username),
    content: stripBotMention(item.content ?? "", client.user?.id ?? ""),
    attachments: [...item.attachments.values()].map((attachment) => attachment.name),
  });

  let reply: DiscordContextEntry | null = null;
  if (message.reference?.messageId) {
    try {
      reply = toEntry(await message.fetchReference());
    } catch (error) {
      console.warn(`reply context unavailable message=${message.id}`, String(error));
    }
  }

  let history: DiscordContextEntry[] = [];
  if (includeHistory) {
    try {
      const recent = await message.channel.messages.fetch({ before: message.id, limit: 20 });
      history = [...recent.values()]
        .filter(
          (item) =>
            item.id !== reply?.id &&
            isSupportedMessageType(Number(item.type)) &&
            (allowedUsers.has(item.author.id) || item.author.id === client.user?.id),
        )
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .slice(-8)
        .map(toEntry);
    } catch (error) {
      console.warn(`history context unavailable message=${message.id}`, String(error));
    }
  }
  return { reply, history };
}

client.once("clientReady", async () => {
  try {
    await validateRouteChannels();
    const recovered = runtime.recoverInterrupted("bridge service restart");
    const terminalProgressCleaned = await cleanupTerminalProgress();
    const orphanedQuestionsCleaned = await cleanupOrphanedQuestionComponents();
    const expiredAttachmentsCleaned = cleanupExpiredAttachments();
    console.log(
      `native bridge ready bot=${client.user?.tag} routes=${config.routes.length} recovered=${recovered} terminal_progress_cleanup=${terminalProgressCleaned} orphaned_question_cleanup=${orphanedQuestionsCleaned} attachment_cleanup=${expiredAttachmentsCleaned} state=${statePath}`,
    );
    queuePoll = setInterval(() => {
      if (store.hasRunnable()) void runtime.runUntilIdle().catch((error) => console.error("queue poll failed", error));
    }, 2_000);
    queuePoll.unref();
    attachmentCleanupTimer = setInterval(() => {
      try {
        const deleted = cleanupExpiredAttachments();
        if (deleted > 0) console.log(`attachment cleanup deleted=${deleted}`);
      } catch (error) {
        console.warn("attachment cleanup failed", String(error));
      }
    }, 6 * 60 * 60 * 1_000);
    attachmentCleanupTimer.unref();
    void runtime.runUntilIdle().catch((error) => console.error("startup pump failed", error));
  } catch (error) {
    console.error("native bridge startup validation failed", error);
    client.destroy();
    setTimeout(() => process.exit(1), 100).unref();
  }
});

client.on("messageCreate", (message) => {
  void messageLifecycleQueue.run(message.id, async () => {
    try {
    if (!message.inGuild() || !client.user) return;
    if (message.author.id === client.user.id) return;
    if (!isSupportedMessageType(Number(message.type))) return;
    if (!allowedUsers.has(message.author.id)) return;
    if (message.author.bot && !allowedUsers.has(message.author.id)) return;

    const parentId = message.channel.isThread() ? message.channel.parentId : null;
    const route = resolveRoute(config, message.channelId, parentId);
    if (!route) return;
    if (route.requireMention && !message.mentions.users.has(client.user.id)) return;
    if (store.getByMessageId(message.id)) return;

    const key = conversationKey(route, message.channelId);
    let promptText = stripBotMention(message.content ?? "", client.user.id);
    let rawPrompt = false;
    if (promptText === "!status") {
      await message.reply({ content: formatDiscordStatus(renderStatusSnapshot(store.listActive())), allowedMentions: { parse: [] } });
      return;
    }
    if (promptText === "!cancel") {
      const cancelled = store.cancelByConversation(key);
      const boards = new Map<string, ProgressBoard>();
      for (const job of cancelled) {
        questionBroker.cancelJob(job.id, "cancelled by user");
        executor.cancel(job.id);
        await cleanupQuestionComponentsForJob(job);
        stopTyping(job.id);
        const board = progressBoards.get(job.id) ?? (job.progressMessageId ? new ProgressBoard(job) : null);
        if (board) {
          await board.cancel();
          boards.set(job.id, board);
        }
      }
      await message.reply({ content: `중지 요청 ${cancelled.length}건 처리`, allowedMentions: { parse: [] } });
      for (const job of cancelled) {
        const board = boards.get(job.id);
        if (board) await board.cleanupAfterFinalDelivery();
        progressBoards.delete(job.id);
      }
      return;
    }

    const control = parseControlCommand(promptText);
    if (control?.kind === "setting") {
      const running = store.listActive().find((job) => job.conversationKey === key && job.status === "running");
      let appliedLive = false;
      try {
        if (running && control.field === "model") {
          appliedLive = await executor.setModel(running.id, control.value ?? route.model);
        } else if (running && control.field === "permissionMode") {
          appliedLive = await executor.setPermissionMode(
            running.id,
            (control.value ?? route.permissionMode) as typeof route.permissionMode,
          );
        }
      } catch (error) {
        await message.reply({
          content: `실행 중 설정 적용 실패: ${error instanceof Error ? error.message : String(error)}`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      const settings = store.setConversationSetting(key, control.field, control.value);
      await message.reply({
        content: `${appliedLive ? "실행 중 적용 + " : ""}설정 저장됨 · model=${settings.model ?? route.model} · permission=${settings.permissionMode ?? route.permissionMode} · effort=${settings.effort ?? route.effort}`,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (control?.kind === "fork") {
      store.requestFork(key);
      await message.reply({ content: "다음 resume 작업을 현재 세션에서 fork하도록 예약했어.", allowedMentions: { parse: [] } });
      return;
    }
    if (control?.kind === "branches") {
      const branches = store.listSessionBranches(key);
      const content = branches.length
        ? branches
            .map((branch) => `${branch.status === "active" ? "*" : "-"} ${branch.sessionId.slice(0, 8)} · ${branch.label ?? "session"}`)
            .join("\n")
        : "저장된 branch 없음";
      await message.reply({ content, allowedMentions: { parse: [] } });
      return;
    }
    if (control?.kind === "checkpoints") {
      const checkpoints = store.listSessionCheckpoints(key);
      const content = checkpoints.length
        ? checkpoints
            .map((checkpoint) => `- ${checkpoint.userMessageId} · session ${checkpoint.sessionId.slice(0, 8)}`)
            .join("\n")
        : "저장된 checkpoint 없음";
      await message.reply({ content, allowedMentions: { parse: [] } });
      return;
    }
    if (control?.kind === "useBranch") {
      const active = store.listActive().some((job) => job.conversationKey === key);
      if (active) {
        await message.reply({ content: "active job이 끝난 뒤 branch를 전환해줘.", allowedMentions: { parse: [] } });
        return;
      }
      try {
        const selected = store.useSessionBranch(key, control.prefix);
        await message.reply({ content: `branch 전환됨 · ${selected.sessionId}`, allowedMentions: { parse: [] } });
      } catch (error) {
        await message.reply({ content: error instanceof Error ? error.message : String(error), allowedMentions: { parse: [] } });
      }
      return;
    }
    if (control?.kind === "reset") {
      const active = store.listActive().some((candidate) => candidate.conversationKey === key);
      if (active) {
        await message.reply({ content: "실행·대기 중인 작업이 있어서 reset하지 않았어. 먼저 !cancel 해줘.", allowedMentions: { parse: [] } });
      } else {
        store.resetSession(key, route.id);
        await message.reply({ content: "Claude 세션을 새로 시작하도록 reset했어.", allowedMentions: { parse: [] } });
      }
      return;
    }
    if (control?.kind === "settings") {
      const settings = store.getConversationSettings(key);
      await message.reply({
        content: [
          `model: ${settings.model ?? `${route.model} (route default)`}`,
          `fallback: ${route.fallbackModel ?? "없음"}`,
          `permission: ${settings.permissionMode ?? `${route.permissionMode} (route default)`}`,
          `effort: ${settings.effort ?? `${route.effort} (route default)`}`,
          `fork next: ${settings.forkNext ? "yes" : "no"}`,
          `session history: ${store.sessionHasHistory(key) ? "yes" : "no"}`,
        ].join("\n"),
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (control?.kind === "rewindPreview") {
      if (store.listActive().some((job) => job.conversationKey === key)) {
        await message.reply({ content: "active job이 끝난 뒤 rewind preview를 실행해줘.", allowedMentions: { parse: [] } });
        return;
      }
      const matches = store
        .listSessionCheckpoints(key)
        .filter((checkpoint) => checkpoint.userMessageId.startsWith(control.checkpoint));
      if (matches.length !== 1) {
        await message.reply({ content: matches.length === 0 ? "checkpoint 없음" : "checkpoint prefix가 모호함", allowedMentions: { parse: [] } });
        return;
      }
      const checkpoint = matches[0]!;
      const activeBranch = store.listSessionBranches(key).find((branch) => branch.status === "active");
      if (!activeBranch || activeBranch.sessionId !== checkpoint.sessionId) {
        await message.reply({ content: "checkpoint가 현재 active branch 소속이 아냐.", allowedMentions: { parse: [] } });
        return;
      }
      try {
        const preview = await executor.rewindSession(route.cwd, checkpoint.sessionId, checkpoint.userMessageId, true);
        if (!preview.canRewind) {
          await message.reply({ content: `rewind 불가: ${preview.error ?? "원인 없음"}`, allowedMentions: { parse: [] } });
          return;
        }
        const operation = store.createRewindOperation(key, checkpoint.sessionId, checkpoint.userMessageId, preview);
        const files = preview.filesChanged?.slice(0, 15).join("\n") || "변경 파일 정보 없음";
        await message.reply({
          content: `rewind preview · op=${operation.id}\ninsertions=${preview.insertions ?? 0} deletions=${preview.deletions ?? 0}\n${files}\n\n적용: !rewind apply ${operation.id}`,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        await message.reply({ content: `rewind preview 실패: ${error instanceof Error ? error.message : String(error)}`, allowedMentions: { parse: [] } });
      }
      return;
    }
    if (control?.kind === "rewindApply") {
      if (store.listActive().some((job) => job.conversationKey === key)) {
        await message.reply({ content: "active job이 끝난 뒤 rewind apply를 실행해줘.", allowedMentions: { parse: [] } });
        return;
      }
      const operation = store.getRewindOperation(key, control.operationId);
      const activeBranch = store.listSessionBranches(key).find((branch) => branch.status === "active");
      if (!operation || operation.status !== "previewed") {
        await message.reply({ content: "유효한 preview operation이 아냐.", allowedMentions: { parse: [] } });
        return;
      }
      if (Date.now() - Date.parse(operation.createdAt) > 15 * 60 * 1_000) {
        await message.reply({ content: "preview가 15분을 지나 만료됐어. 다시 preview해줘.", allowedMentions: { parse: [] } });
        return;
      }
      if (!activeBranch || activeBranch.sessionId !== operation.sessionId) {
        await message.reply({ content: "preview 이후 active branch가 바뀌어서 적용하지 않았어.", allowedMentions: { parse: [] } });
        return;
      }
      if (!store.markRewindApplied(operation.id)) {
        await message.reply({ content: "operation이 이미 소비됐어.", allowedMentions: { parse: [] } });
        return;
      }
      try {
        const applied = await executor.rewindSession(route.cwd, operation.sessionId, operation.checkpoint, false);
        await message.reply({
          content: applied.canRewind
            ? `rewind 적용됨 · files=${applied.filesChanged?.length ?? operation.preview.filesChanged?.length ?? 0}`
            : `rewind 적용 실패: ${applied.error ?? "원인 없음"}`,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        await message.reply({ content: `rewind 적용 실패: ${error instanceof Error ? error.message : String(error)} · 다시 preview가 필요해.`, allowedMentions: { parse: [] } });
      }
      return;
    }
    if (control?.kind === "help") {
      await message.reply({
        content: "!status · !cancel · !settings · !model · !permission · !effort · !fork · !branch list/use · !checkpoint list · !rewind preview/apply · !reset · !compact · !claude /command · !background",
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (control?.kind === "unsupported") {
      await message.reply({ content: control.message, allowedMentions: { parse: [] } });
      return;
    }
    if (control?.kind === "raw") {
      promptText = control.prompt;
      rawPrompt = true;
    } else if (control?.kind === "background") {
      promptText = control.prompt;
    }

    const attachments = await downloadAttachments(message.id, message.attachments.values());
    let prompt = promptText;
    if (!prompt && attachments.paths.length > 0) prompt = "첨부 파일을 확인하고 필요한 작업을 수행해.";
    if (attachments.errors.length > 0) prompt += `\n\n첨부 다운로드 오류:\n${attachments.errors.join("\n")}`;
    if (!prompt.trim()) {
      await message.reply({ content: "작업 내용을 적어줘.", allowedMentions: { parse: [] } });
      return;
    }
    const steeringContent = prompt;
    let pendingSteeringFallback = false;
    if (!rawPrompt) {
      prompt = appendDiscordContext(prompt, await discordContextFor(message, !store.sessionHasHistory(key)));
    }

    const running = store
      .listActive()
      .find((candidate) => candidate.conversationKey === key && candidate.status === "running");
    const steeringPrompt = rawPrompt ? promptText : `[Discord 실행 중 추가 지시 · message=${message.id}]\n${prompt}`;
    if (running) {
      const existingSteering = store.getSteeringInput(message.id);
      if (existingSteering && existingSteering.state !== "pending") {
        await message.react("👀").catch(() => undefined);
        console.log(`duplicate steering ignored id=${running.id} message=${message.id}`);
        return;
      }
      const sdkMessageId = existingSteering?.sdkMessageId ?? crypto.randomUUID();
      store.beginSteeringInput({
        messageId: message.id,
        jobId: running.id,
        conversationKey: key,
        content: steeringContent,
        sdkMessageId,
      });
      if (executor.steer(running.id, steeringPrompt, sdkMessageId)) {
        store.acceptSteeringInput(message.id);
        await message.react("👀").catch(() => undefined);
        console.log(`job steered id=${running.id} message=${message.id} sdk_message=${sdkMessageId} len=${prompt.length}`);
        return;
      }
      pendingSteeringFallback = true;
      console.log(`steering actor closed; durable fallback enqueue id=${running.id} message=${message.id}`);
    }

    const job = store.enqueue({
      routeId: route.id,
      lockKey: route.lockKey ?? route.cwd,
      conversationKey: key,
      channelId: message.channelId,
      threadId: parentId ? message.channelId : null,
      messageId: message.id,
      authorId: message.author.id,
      prompt,
      rawPrompt,
      attachmentPaths: attachments.paths,
    }, pendingSteeringFallback ? message.id : undefined);
    await message.react("👀").catch(() => undefined);
    console.log(
      `job queued id=${job.id} route=${route.id} channel=${message.channelId} author=${message.author.id} len=${prompt.length}`,
    );
    void runtime.runUntilIdle().catch((error) => console.error("job pump failed", error));
    } catch (error) {
      console.error("message handler failed", error);
      await message.reply({ content: "⛔ 작업 등록 중 오류가 났어. 로그를 확인할게.", allowedMentions: { parse: [] } }).catch(() => undefined);
    }
  });
});

client.on("messageUpdate", (_oldMessage, updatedMessage) => {
  void messageLifecycleQueue.run(updatedMessage.id, async () => {
    try {
    const sourceJob = store.getByMessageId(updatedMessage.id);
    const steering = sourceJob ? null : store.getSteeringInput(updatedMessage.id);
    const job = sourceJob ?? (steering ? store.getJob(steering.jobId) : null);
    if (!job) return;
    if (sourceJob && !["queued", "running"].includes(sourceJob.status)) return;
    if (steering?.state === "deleted") return;
    const message = updatedMessage.partial ? await updatedMessage.fetch() : updatedMessage;
    if (!message.inGuild() || !client.user || message.author.id !== job.authorId || !allowedUsers.has(message.author.id)) return;

    const attachments = await downloadAttachments(message.id, message.attachments.values());
    let basePrompt = stripBotMention(message.content ?? "", client.user.id);
    if (!basePrompt && attachments.paths.length > 0) basePrompt = "첨부 파일을 확인하고 필요한 작업을 수행해.";
    if (attachments.errors.length > 0) basePrompt += `\n\n첨부 다운로드 오류:\n${attachments.errors.join("\n")}`;

    if (steering) {
      if (!basePrompt.trim()) {
        await retractDeletedSteering(message.id, "follow-up message cleared by edit");
        return;
      }
      if (steering.content === basePrompt) return;
      const contextualPrompt = appendDiscordContext(
        basePrompt,
        await discordContextFor(message, !store.sessionHasHistory(job.conversationKey)),
      );
      const desired = store.prepareSteeringEdit(message.id, basePrompt);
      if (!desired) return;
      const steeringEditPrompt = `[Discord 추가 지시 수정 · message=${message.id}]\n${contextualPrompt}`;
      const mutation =
        job.status === "running"
          ? executor.editSteering(
              job.id,
              desired.sdkMessageId,
              steeringEditPrompt,
              message.id,
              desired.originalSdkMessageId,
            )
          : null;
      if (mutation) {
        store.recordSteeringMutation(message.id, mutation.sdkMessageId);
      } else if (job.status === "running") {
        const fallback = store.enqueue({
          routeId: job.routeId,
          lockKey: job.lockKey,
          conversationKey: job.conversationKey,
          channelId: job.channelId,
          threadId: job.threadId,
          messageId: steeringFallbackMessageId("edit", message.id, basePrompt),
          authorId: job.authorId,
          prompt: steeringEditPrompt,
          attachmentPaths: attachments.paths,
        });
        console.log(`steering edit actor closed; fallback job=${fallback.id} source_job=${job.id} message=${message.id}`);
        void runtime.runUntilIdle().catch((error) => console.error("steering edit fallback pump failed", error));
      }
      console.log(
        `steering message updated job=${job.id} message=${message.id} mode=${mutation?.mode ?? "record-or-fallback"} status=${job.status}`,
      );
      return;
    }

    if (!basePrompt.trim()) {
      const cancelled = store.cancelByMessageId(message.id, "source message cleared by edit");
      if (cancelled) executor.cancel(cancelled.id);
      return;
    }
    const prompt = appendDiscordContext(
      basePrompt,
      await discordContextFor(message, !store.sessionHasHistory(job.conversationKey)),
    );
    const queued = store.updateQueuedPrompt(message.id, prompt, attachments.paths);
    if (queued) {
      console.log(`queued job updated id=${queued.id} message=${message.id} len=${prompt.length}`);
      return;
    }
    if (executor.steer(job.id, `[Discord 원본 요청 수정 · message=${message.id}]\n${prompt}`)) {
      console.log(`running source edit steered id=${job.id} message=${message.id}`);
      return;
    }
    console.warn(`running source edit could not steer id=${job.id} message=${message.id}`);
    } catch (error) {
      console.error("message update handler failed", error);
    }
  });
});

async function cancelDeletedSource(messageId: string): Promise<void> {
  const job = store.getByMessageId(messageId);
  if (!job) return;
  const cancelled = store.cancelByMessageId(messageId);
  if (!cancelled) return;
  questionBroker.cancelJob(cancelled.id, "source message deleted");
  executor.cancel(cancelled.id);
  await cleanupQuestionComponentsForJob(cancelled);
  stopTyping(cancelled.id);
  const board = progressBoards.get(cancelled.id) ?? (job.progressMessageId ? new ProgressBoard(job) : null);
  if (board) {
    await board.cancel();
    await board.cleanupAfterFinalDelivery();
  }
  progressBoards.delete(cancelled.id);
  console.log(`job cancelled after source deletion id=${cancelled.id} message=${messageId}`);
}

async function retractDeletedSteering(messageId: string, reason = "follow-up message deleted"): Promise<void> {
  const steering = store.getSteeringInput(messageId);
  if (!steering || steering.state === "deleted") return;
  const job = store.getJob(steering.jobId);
  if (!job) return;
  const desired = store.prepareSteeringDelete(messageId);
  if (!desired) return;
  const retractionPrompt = [
    `[Discord 추가 지시 삭제 · message=${messageId}]`,
    `원본 SDK user message: ${desired.originalSdkMessageId}`,
    `직전 SDK user message: ${desired.sdkMessageId}`,
    "이 Discord logical message의 원본과 모든 수정본을 더 이상 따르지 마. 이미 발생한 외부 side effect는 임의로 되돌리지 말고 최종 결과에 알려.",
  ].join("\n");
  const mutation =
    job.status === "running"
      ? executor.deleteSteering(
          job.id,
          desired.sdkMessageId,
          messageId,
          desired.originalSdkMessageId,
        )
      : null;
  if (mutation) {
    store.recordSteeringMutation(messageId, mutation.sdkMessageId);
  } else if (job.status === "running") {
    const fallback = store.enqueue({
      routeId: job.routeId,
      lockKey: job.lockKey,
      conversationKey: job.conversationKey,
      channelId: job.channelId,
      threadId: job.threadId,
      messageId: steeringFallbackMessageId("delete", messageId),
      authorId: job.authorId,
      prompt: retractionPrompt,
      attachmentPaths: [],
    });
    console.log(`steering delete actor closed; fallback job=${fallback.id} source_job=${job.id} message=${messageId}`);
    void runtime.runUntilIdle().catch((error) => console.error("steering delete fallback pump failed", error));
  }
  console.log(
    `steering message deleted job=${job.id} message=${messageId} mode=${mutation?.mode ?? "record-or-fallback"} status=${job.status} reason=${reason}`,
  );
}

async function handleDeletedMessage(messageId: string): Promise<void> {
  if (store.getByMessageId(messageId)) {
    await cancelDeletedSource(messageId);
    return;
  }
  await retractDeletedSteering(messageId);
}

client.on("messageDelete", (message) => {
  void messageLifecycleQueue
    .run(message.id, () => handleDeletedMessage(message.id))
    .catch((error) => console.error("message delete handler failed", error));
});

client.on("messageDeleteBulk", (messages) => {
  for (const messageId of messages.keys()) {
    void messageLifecycleQueue
      .run(messageId, () => handleDeletedMessage(messageId))
      .catch((error) => console.error("bulk message delete handler failed", error));
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  const parsed = parseQuestionButtonId(interaction.customId);
  if (!parsed) return;
  try {
    if (!allowedUsers.has(interaction.user.id)) {
      await interaction.reply({ content: "이 질문은 owner만 답할 수 있어.", ephemeral: true });
      return;
    }
    const record = store.getInteraction(parsed.interactionId);
    const interactionJob = record ? store.getJob(record.jobId) : null;
    if (!record || !interactionJob || record.discordMessageId !== interaction.message.id) {
      await interaction.reply({ content: "만료되었거나 알 수 없는 질문이야.", ephemeral: true });
      return;
    }
    if (interaction.user.id !== interactionJob.authorId) {
      await interaction.reply({ content: "이 질문을 시작한 사용자만 답할 수 있어.", ephemeral: true });
      return;
    }
    if (record.status === "orphaned") {
      await interaction.update({
        content: `${renderInteractiveQuestion(record.question)}\n\n⛔ 질문 취소됨`,
        components: [],
        allowedMentions: { parse: [] },
      });
      store.clearInteractionMessage(record.id);
      return;
    }
    if (record.status !== "pending") {
      await interaction.reply({
        content: `이미 답변됨: ${record.answer ?? "(답 없음)"}`,
        ephemeral: true,
      });
      return;
    }
    const choice = record.question.choices[parsed.choiceIndex];
    if (!choice) {
      await interaction.reply({ content: "유효하지 않은 선택지야.", ephemeral: true });
      return;
    }
    const released = questionBroker.answerMessage(interaction.message.id, choice);
    if (!released) {
      const accepted = store.tryAnswerInteraction(record.id, choice);
      if (!accepted) {
        const current = store.getInteraction(record.id);
        await interaction.reply({
          content: current?.status === "answered" ? `이미 답변됨: ${current.answer ?? "(답 없음)"}` : "만료된 질문이야.",
          ephemeral: true,
        });
        return;
      }
    }
    await interaction.update({
      content: renderAnsweredInteractiveQuestion(record.question, choice),
      components: [],
      allowedMentions: { parse: [] },
    });
    console.log(`Discord question answered by button interaction=${record.id} user=${interaction.user.id} choice=${parsed.choiceIndex}`);
  } catch (error) {
    console.error("button interaction handler failed", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "질문 답변 처리 중 오류가 났어.", ephemeral: true }).catch(() => undefined);
    }
  }
});

client.on("error", (error) => console.error("discord client error", error));
client.on("shardError", (error) => console.error("discord shard error", error));

let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`stopping native bridge signal=${signal}`);
  for (const timer of typingTimers.values()) clearInterval(timer);
  if (queuePoll) clearInterval(queuePoll);
  if (attachmentCleanupTimer) clearInterval(attachmentCleanupTimer);
  client.destroy();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("unhandledRejection", (error) => console.error("unhandled rejection", error));
process.on("uncaughtException", (error) => {
  console.error("uncaught exception", error);
  process.exit(1);
});

await client.login(token);
