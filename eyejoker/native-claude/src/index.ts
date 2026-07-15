#!/usr/bin/env bun
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type GuildTextBasedChannel,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { ClaudeProcessExecutor } from "./executor";
import { buildFinalChunkOptions, formatFinalMessage, splitDiscordMessage } from "./protocol";
import { progressElapsedSeconds, workElapsedSeconds } from "./duration";
import { ProgressLifecycle, progressCleanupFallbackText } from "./progress-lifecycle";
import { cleanupExpiredAttachmentDirs } from "./attachment-cleanup";
import { extractOutboundArtifacts } from "./outbound-artifacts";
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
const executor = new ClaudeProcessExecutor({
  binary: process.env.CLAUDE_NATIVE_CLAUDE_BIN ?? "claude",
  timeoutSeconds: config.jobTimeoutSeconds,
});
const typingTimers = new Map<string, ReturnType<typeof setInterval>>();
const progressBoards = new Map<string, ProgressBoard>();
const attachmentRoot = join(stateDir, "attachments");
const attachmentTtlMs = 7 * 24 * 60 * 60 * 1_000;
let queuePoll: ReturnType<typeof setInterval> | null = null;
let attachmentCleanupTimer: ReturnType<typeof setInterval> | null = null;

function cleanupExpiredAttachments(): number {
  return cleanupExpiredAttachmentDirs(attachmentRoot, {
    activePaths: store.listActive().flatMap((job) => job.attachmentPaths),
    ttlMs: attachmentTtlMs,
  }).length;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
});

async function textChannel(id: string): Promise<GuildTextBasedChannel> {
  const channel = await client.channels.fetch(id);
  if (!channel?.isTextBased() || channel.isDMBased()) throw new Error(`Discord channel is unavailable: ${id}`);
  return channel as GuildTextBasedChannel;
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
  const renderedChunks = splitDiscordMessage(
    formatFinalMessage(config.ownerId, execution.ok, artifacts.body, elapsed, mainModel, subagentModels),
  );
  const plan = store.prepareDelivery(job.id, renderedChunks, artifacts.files);
  const channel = await textChannel(job.channelId);
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
  );

  // Match the old NanoClaw contract: a temporary card only disappears after
  // the real user-facing result has been accepted by Discord. Cleanup is
  // best-effort and must never cause a duplicate final delivery retry.
  const board = progressBoards.get(job.id) ?? (job.progressMessageId ? new ProgressBoard(job) : null);
  if (board) {
    await board.cleanupAfterFinalDelivery();
    progressBoards.delete(job.id);
  }
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
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > 25 * 1024 * 1024) throw new Error("download exceeded 25MB");
      const path = join(targetDir, sanitizeAttachmentName(attachment.name));
      writeFileSync(path, data, { mode: 0o600 });
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
    const expiredAttachmentsCleaned = cleanupExpiredAttachments();
    console.log(
      `native bridge ready bot=${client.user?.tag} routes=${config.routes.length} recovered=${recovered} terminal_progress_cleanup=${terminalProgressCleaned} attachment_cleanup=${expiredAttachmentsCleaned} state=${statePath}`,
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

client.on("messageCreate", async (message) => {
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
    const promptText = stripBotMention(message.content ?? "", client.user.id);
    if (promptText === "!status") {
      await message.reply({ content: formatDiscordStatus(renderStatusSnapshot(store.listActive())), allowedMentions: { parse: [] } });
      return;
    }
    if (promptText === "!cancel") {
      const cancelled = store.cancelByConversation(key);
      const boards = new Map<string, ProgressBoard>();
      for (const job of cancelled) {
        executor.cancel(job.id);
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

    const attachments = await downloadAttachments(message.id, message.attachments.values());
    let prompt = promptText;
    if (!prompt && attachments.paths.length > 0) prompt = "첨부 파일을 확인하고 필요한 작업을 수행해.";
    if (attachments.errors.length > 0) prompt += `\n\n첨부 다운로드 오류:\n${attachments.errors.join("\n")}`;
    if (!prompt.trim()) {
      await message.reply({ content: "작업 내용을 적어줘.", allowedMentions: { parse: [] } });
      return;
    }
    prompt = appendDiscordContext(prompt, await discordContextFor(message, !store.sessionHasHistory(key)));

    const job = store.enqueue({
      routeId: route.id,
      lockKey: route.lockKey ?? route.cwd,
      conversationKey: key,
      channelId: message.channelId,
      threadId: parentId ? message.channelId : null,
      messageId: message.id,
      authorId: message.author.id,
      prompt,
      attachmentPaths: attachments.paths,
    });
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

client.on("messageUpdate", async (_oldMessage, updatedMessage) => {
  try {
    const job = store.getByMessageId(updatedMessage.id);
    if (!job || !["queued", "running"].includes(job.status)) return;
    const message = updatedMessage.partial ? await updatedMessage.fetch() : updatedMessage;
    if (!message.inGuild() || !client.user || message.author.id !== job.authorId || !allowedUsers.has(message.author.id)) return;

    const attachments = await downloadAttachments(message.id, message.attachments.values());
    let prompt = stripBotMention(message.content ?? "", client.user.id);
    if (!prompt && attachments.paths.length > 0) prompt = "첨부 파일을 확인하고 필요한 작업을 수행해.";
    if (attachments.errors.length > 0) prompt += `\n\n첨부 다운로드 오류:\n${attachments.errors.join("\n")}`;
    if (!prompt.trim()) {
      const cancelled = store.cancelByMessageId(message.id, "source message cleared by edit");
      if (cancelled) executor.cancel(cancelled.id);
      return;
    }
    prompt = appendDiscordContext(
      prompt,
      await discordContextFor(message, !store.sessionHasHistory(job.conversationKey)),
    );
    const queued = store.updateQueuedPrompt(message.id, prompt, attachments.paths);
    if (queued) {
      console.log(`queued job updated id=${queued.id} message=${message.id} len=${prompt.length}`);
      return;
    }
    // A running edit is forwarded by the interactive stdin controller added below.
    console.log(`running source edited id=${job.id} message=${message.id}`);
  } catch (error) {
    console.error("message update handler failed", error);
  }
});

async function cancelDeletedSource(messageId: string): Promise<void> {
  const job = store.getByMessageId(messageId);
  if (!job) return;
  const cancelled = store.cancelByMessageId(messageId);
  if (!cancelled) return;
  executor.cancel(cancelled.id);
  stopTyping(cancelled.id);
  const board = progressBoards.get(cancelled.id) ?? (job.progressMessageId ? new ProgressBoard(job) : null);
  if (board) {
    await board.cancel();
    await board.cleanupAfterFinalDelivery();
  }
  progressBoards.delete(cancelled.id);
  console.log(`job cancelled after source deletion id=${cancelled.id} message=${messageId}`);
}

client.on("messageDelete", (message) => {
  void cancelDeletedSource(message.id).catch((error) => console.error("message delete handler failed", error));
});

client.on("messageDeleteBulk", (messages) => {
  for (const messageId of messages.keys()) {
    void cancelDeletedSource(messageId).catch((error) => console.error("bulk message delete handler failed", error));
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
