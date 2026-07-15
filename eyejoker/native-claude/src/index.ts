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
  conversationKey,
  isReplyableMessageId,
  isSupportedMessageType,
  sanitizeAttachmentName,
  stripBotMention,
} from "./bridge-utils";
import { loadConfig, resolveRoute } from "./config";
import { ClaudeProcessExecutor } from "./executor";
import { formatFinalMessage, splitDiscordMessage } from "./protocol";
import { ProgressLifecycle } from "./progress-lifecycle";
import { JobRuntime } from "./runtime";
import {
  StreamProgressAggregator,
  renderProgressCard,
  type ProgressEvent,
} from "./stream-progress";
import { StateStore } from "./store";
import { formatDiscordStatus, renderStatusSnapshot } from "./status-format";
import type { JobRecord } from "./types";

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
let queuePoll: ReturnType<typeof setInterval> | null = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
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
      ];
      if (!permissions || !required.every((permission) => permissions.has(permission))) {
        failures.push(`${route.id}: missing view/send/thread permission`);
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
  private lastEditAt = 0;
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
    this.lastEditAt = Date.now();
    store.setProgress(this.job.id, message.id, content);
  }

  handleEvent(event: ProgressEvent, aggregator: StreamProgressAggregator): void {
    if (this.closed) return;
    this.latest = aggregator;
    const force =
      event.kind === "tool_start" ||
      event.kind === "tool_result" ||
      event.kind === "result" ||
      event.kind === "status" ||
      event.kind === "system";
    void this.queueCardEdit(force);
  }

  private elapsedSeconds(): number {
    return Math.max(0, Math.round((Date.now() - Date.parse(this.job.createdAt)) / 1000));
  }

  private render(mode: "running" | "final" | "cancelled", ok = true): string {
    return renderProgressCard({
      routeId: this.job.routeId,
      attempt: this.job.attempts,
      maxAttempts: config.maxAttempts,
      elapsedSeconds: this.elapsedSeconds(),
      promptPreview: this.job.prompt,
      recoveryReason: this.job.recoveryReason,
      snapshot: this.latest.snapshot(),
      mode,
      ok,
    });
  }

  private queueCardEdit(force: boolean): void {
    if (this.closed || !this.message) return;
    const minInterval = force ? 800 : 1500;
    const dueIn = Math.max(0, minInterval - (Date.now() - this.lastEditAt));
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.flushCard();
    }, dueIn);
    this.pending.unref?.();
  }

  private async flushCard(mode: "running" | "final" | "cancelled" = "running", ok = true): Promise<void> {
    if (!this.message) return;
    if (this.closed && mode === "running") return;
    const content = this.render(mode, ok);
    if (content === this.lastCard && mode === "running") return;
    try {
      this.message = await this.message.edit({ content, allowedMentions: { parse: [] } });
      this.lastCard = content;
      this.lastEditAt = Date.now();
      store.setProgress(this.job.id, this.message.id, content);
    } catch (error) {
      console.warn("progress card edit failed", this.job.id, String(error));
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
        await message.edit({ content: "✅ 완료", allowedMentions: { parse: [] } });
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

async function deliverFinal(job: JobRecord, ok: boolean, result: string): Promise<void> {
  stopTyping(job.id);
  const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(job.createdAt)) / 1000));
  const chunks = splitDiscordMessage(formatFinalMessage(config.ownerId, ok, result, elapsed));
  const channel = await textChannel(job.channelId);
  for (const [index, chunk] of chunks.entries()) {
    const options: MessageCreateOptions = {
      content: chunk,
      allowedMentions: index === 0 ? { users: [config.ownerId] } : { parse: [] },
    };
    if (index === 0 && isReplyableMessageId(job.messageId)) {
      options.reply = { messageReference: job.messageId, failIfNotExists: false };
    }
    await channel.send(options);
  }

  // Match the old NanoClaw contract: a temporary card only disappears after
  // the real user-facing result has been accepted by Discord. Cleanup is
  // best-effort and must never cause a duplicate final delivery retry.
  const board = progressBoards.get(job.id) ?? (job.progressMessageId ? new ProgressBoard(job) : null);
  if (board) {
    await board.cleanupAfterFinalDelivery();
    progressBoards.delete(job.id);
  }
  console.log(`job final id=${job.id} route=${job.routeId} ok=${ok} elapsed=${elapsed}`);
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
    await deliverFinal(job, execution.ok, execution.result);
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
  const targetDir = join(stateDir, "attachments", messageId);
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

client.once("clientReady", async () => {
  try {
    await validateRouteChannels();
    const recovered = runtime.recoverInterrupted("bridge service restart");
    const terminalProgressCleaned = await cleanupTerminalProgress();
    console.log(
      `native bridge ready bot=${client.user?.tag} routes=${config.routes.length} recovered=${recovered} terminal_progress_cleanup=${terminalProgressCleaned} state=${statePath}`,
    );
    queuePoll = setInterval(() => {
      if (store.hasRunnable()) void runtime.runUntilIdle().catch((error) => console.error("queue poll failed", error));
    }, 2_000);
    queuePoll.unref();
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

client.on("error", (error) => console.error("discord client error", error));
client.on("shardError", (error) => console.error("discord shard error", error));

let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`stopping native bridge signal=${signal}`);
  for (const timer of typingTimers.values()) clearInterval(timer);
  if (queuePoll) clearInterval(queuePoll);
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
