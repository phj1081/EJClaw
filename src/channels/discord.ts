import fs from 'fs';
import path from 'path';

import {
  Attachment,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  MessageFlags,
  TextChannel,
} from 'discord.js';

import { CACHE_DIR, DATA_DIR } from '../config.js';
import { getEnv } from '../env.js';
import { logger } from '../logger.js';
import { validateOutboundAttachments } from '../outbound-attachments.js';
import { formatOutbound } from '../router.js';
import { hasReviewerLease } from '../service-routing.js';
import type {
  DeleteRecentMessagesByContentOptions,
  SendMessageOptions,
  SendMessageResult,
} from '../types.js';
import {
  DASHBOARD_TRACKED_SEND_GRACE_MS,
  deleteOwnDashboardDuplicateOnCreate,
  isDashboardTrackedSend,
} from './discord-dashboard-create-cleanup.js';
import { deleteRecentDiscordMessagesByContent } from './discord-message-cleanup.js';
import { prepareDiscordOutbound } from './discord-outbound.js';

const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const TRANSCRIPTION_CACHE_DIR = path.join(CACHE_DIR, 'transcriptions');
const DISCORD_OWNER_CHANNEL = 'discord';
const DISCORD_REVIEWER_CHANNEL = 'discord-review';
const DISCORD_ARBITER_CHANNEL = 'discord-arbiter';
const DISCORD_OWNER_TOKEN_KEY = 'DISCORD_OWNER_BOT_TOKEN';
const DISCORD_REVIEWER_TOKEN_KEY = 'DISCORD_REVIEWER_BOT_TOKEN';
const DISCORD_ARBITER_TOKEN_KEY = 'DISCORD_ARBITER_BOT_TOKEN';

/**
 * Download a Discord attachment to local disk.
 * Returns the absolute path to the saved file.
 */
async function downloadAttachment(
  att: Attachment,
  defaultExt = '.bin',
): Promise<string> {
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const ext = path.extname(att.name || `file${defaultExt}`) || defaultExt;
  const filename = `${Date.now()}-${att.id}${ext}`;
  const filePath = path.join(ATTACHMENTS_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  logger.info({ file: filename, size: buffer.length }, 'Attachment downloaded');
  return filePath;
}

/**
 * Wait for a pending transcription from the other service (poll cache file).
 * Returns the cached text, or null if timeout.
 */
async function waitForPendingTranscription(
  cacheFile: string,
  timeoutMs = 15000,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
    if (fs.existsSync(cacheFile)) {
      return fs.readFileSync(cacheFile, 'utf-8');
    }
  }
  return null;
}

/**
 * Transcribe an audio attachment via Groq Whisper (primary) or OpenAI Whisper (fallback).
 * Uses shared file cache so both services don't duplicate API calls.
 */
async function transcribeAudio(att: Attachment): Promise<string> {
  fs.mkdirSync(TRANSCRIPTION_CACHE_DIR, { recursive: true });
  const cacheFile = path.join(TRANSCRIPTION_CACHE_DIR, `${att.id}.txt`);
  const pendingFile = path.join(TRANSCRIPTION_CACHE_DIR, `${att.id}.pending`);

  // Check cache first
  if (fs.existsSync(cacheFile)) {
    logger.info({ attId: att.id }, 'Transcription cache hit');
    return fs.readFileSync(cacheFile, 'utf-8');
  }

  // Another service is already transcribing — wait for result
  if (fs.existsSync(pendingFile)) {
    logger.info({ attId: att.id }, 'Waiting for pending transcription');
    const cached = await waitForPendingTranscription(cacheFile);
    if (cached) return cached;
    // Timeout — fall through and transcribe ourselves
  }

  try {
    // Mark as pending
    fs.writeFileSync(pendingFile, process.pid.toString());

    const start = Date.now();
    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const filename = att.name || 'audio.ogg';

    // Pick provider: Groq (fast) > OpenAI (fallback)
    const groqKey = getEnv('GROQ_API_KEY') || '';
    const openaiKey = getEnv('OPENAI_API_KEY') || '';

    let apiUrl: string;
    let apiKeyToUse: string;
    let model: string;
    let provider: string;

    if (groqKey) {
      apiUrl = 'https://api.groq.com/openai/v1/audio/transcriptions';
      apiKeyToUse = groqKey;
      model = 'whisper-large-v3-turbo';
      provider = 'groq';
    } else if (openaiKey) {
      apiUrl = 'https://api.openai.com/v1/audio/transcriptions';
      apiKeyToUse = openaiKey;
      model = 'whisper-1';
      provider = 'openai';
    } else {
      return `[Audio: ${filename} (no transcription API key)]`;
    }

    const form = new FormData();
    form.append('file', new Blob([buffer]), filename);
    form.append('model', model);

    const whisperRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKeyToUse}` },
      body: form,
    });
    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      throw new Error(`${provider} Whisper ${whisperRes.status}: ${errText}`);
    }
    const data = (await whisperRes.json()) as { text: string };
    const elapsed = Date.now() - start;
    const result = `[Voice message transcription]: ${data.text}`;

    // Save to cache for the other service
    fs.writeFileSync(cacheFile, result);
    logger.info(
      { file: filename, length: data.text.length, provider, elapsed },
      'Audio transcribed + cached',
    );
    return result;
  } catch (err) {
    logger.error({ err, file: att.name }, 'Audio transcription failed');
    return `[Audio: ${att.name || 'audio'} (transcription failed)]`;
  } finally {
    // Clean up pending marker
    try {
      fs.unlinkSync(pendingFile);
    } catch {
      /* ignore */
    }
  }
}
import { registerChannel, ChannelOpts } from './registry.js';
import {
  AgentType,
  Channel,
  ChannelMeta,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  roomBindings: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private typingIntervals = new Map<string, NodeJS.Timeout>();
  private typingGenerations = new Map<string, number>();
  private agentTypeFilter?: AgentType;
  private receivesInbound: boolean;
  private ownsDiscordJids: boolean;
  private dashboardTrackedSendGraceUntil = 0;

  constructor(
    botToken: string,
    opts: DiscordChannelOpts,
    agentTypeFilter?: AgentType,
    channelName?: string,
    receivesInbound = true,
    ownsDiscordJids = true,
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.agentTypeFilter = agentTypeFilter;
    this.receivesInbound = receivesInbound;
    this.ownsDiscordJids = ownsDiscordJids;
    if (channelName) {
      this.name = channelName;
    } else if (agentTypeFilter) {
      this.name = `discord-${agentTypeFilter}`;
    }
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      await this.handleMessageCreate(message);
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  private async handleMessageCreate(message: Message): Promise<void> {
    const channelId = message.channelId;
    const chatJid = `dc:${channelId}`;
    const isOwnBotMessage = message.author.id === this.client?.user?.id;
    if (isOwnBotMessage) {
      await deleteOwnDashboardDuplicateOnCreate({
        message,
        channelName: this.name,
        graceUntil: this.dashboardTrackedSendGraceUntil,
      });
      return;
    }
    if (!this.receivesInbound) return;
    if (message.author.bot && !hasReviewerLease(chatJid)) return;

    let content = message.content;
    const timestamp = message.createdAt.toISOString();
    const senderName =
      message.member?.displayName ||
      message.author.displayName ||
      message.author.username;
    const sender = message.author.id;
    const msgId = message.id;

    // Determine chat name
    let chatName: string;
    if (message.guild) {
      const textChannel = message.channel as TextChannel;
      chatName = `${message.guild.name} #${textChannel.name}`;
    } else {
      chatName = senderName;
    }

    // Handle attachments — transcribe voice messages, download files
    const isVoiceMessage = message.flags.has(MessageFlags.IsVoiceMessage);
    if (message.attachments.size > 0) {
      const attachmentDescriptions = await Promise.all(
        [...message.attachments.values()].map(async (att) => {
          const contentType = att.contentType || '';
          // Voice messages → transcribe; regular audio files → download
          if (
            contentType.startsWith('audio/') &&
            (isVoiceMessage || att.duration != null)
          ) {
            return transcribeAudio(att);
          } else if (
            contentType.startsWith('audio/') ||
            contentType.startsWith('image/')
          ) {
            try {
              const filePath = await downloadAttachment(
                att,
                contentType.startsWith('image/') ? '.png' : '.wav',
              );
              const label = contentType.startsWith('image/')
                ? 'Image'
                : 'Audio';
              const origName = att.name || 'file';
              return `[${label}: ${origName} → ${filePath}]`;
            } catch (err) {
              logger.error(
                { err, file: att.name },
                'Attachment download failed',
              );
              return `[File: ${att.name || 'file'} (download failed)]`;
            }
          } else if (contentType.startsWith('video/')) {
            return `[Video: ${att.name || 'video'}]`;
          } else if (
            contentType.startsWith('text/') ||
            /\.(txt|md|json|csv|log|xml|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|py|js|ts|jsx|tsx|html|css|sql|rs|go|java|c|cpp|h|hpp|rb|php|swift|kt|scala|r|lua|pl|ex|exs|hs|ml|clj|dart|v|zig|nim|ps1|bat|cmd|mjs|cjs)$/i.test(
              att.name || '',
            )
          ) {
            // Download and inline text-based files
            try {
              const res = await fetch(att.url);
              if (!res.ok) throw new Error(`Download failed: ${res.status}`);
              let text = await res.text();
              // Truncate very large files
              const MAX_TEXT_LENGTH = 32_000;
              if (text.length > MAX_TEXT_LENGTH) {
                text =
                  text.slice(0, MAX_TEXT_LENGTH) +
                  `\n...(truncated, ${text.length} chars total)`;
              }
              return `[File: ${att.name}]\n${text}`;
            } catch (err) {
              logger.error(
                { err, file: att.name },
                'Text file download failed',
              );
              return `[File: ${att.name || 'file'} (download failed)]`;
            }
          } else {
            return `[File: ${att.name || 'file'}]`;
          }
        }),
      );
      if (content) {
        content = `${content}\n${attachmentDescriptions.join('\n')}`;
      } else {
        content = attachmentDescriptions.join('\n');
      }
    }

    // Handle reply context — include who the user is replying to
    if (message.reference?.messageId) {
      try {
        const repliedTo = await message.channel.messages.fetch(
          message.reference.messageId,
        );
        const replyAuthor =
          repliedTo.member?.displayName ||
          repliedTo.author.displayName ||
          repliedTo.author.username;
        content = `[Reply to ${replyAuthor}] ${content}`;
      } catch {
        // Referenced message may have been deleted
      }
    }

    // Store chat metadata for discovery
    const isGroup = message.guild !== null;
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'discord', isGroup);

    // Only deliver full message for registered groups. Secondary role bots
    // are configured as outbound-only, while the owner bot receives inbound.
    const group = this.opts.roomBindings()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Discord channel',
      );
      return;
    }
    if (
      this.agentTypeFilter &&
      (group.agentType || 'claude-code') !== this.agentTypeFilter
    ) {
      return; // This JID belongs to a different agent type's bot
    }

    // Deliver message — startMessageLoop() will pick it up
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: message.author.bot ?? false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Discord message stored',
    );
  }

  async sendMessage(
    jid: string,
    text: string,
    options: SendMessageOptions = {},
  ): Promise<SendMessageResult> {
    if (!this.client) {
      throw new Error('Discord client not initialized');
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        throw new Error(`Discord channel not found or not text-based: ${jid}`);
      }

      const textChannel = channel as TextChannel;

      const outbound = prepareDiscordOutbound(text, options.attachments);
      if (outbound.silent) {
        logger.debug(
          { jid, channelName: this.name },
          'Skipping silent structured Discord outbound message',
        );
        return { primaryMessageId: null, messageIds: [], visible: false };
      }
      const validation = validateOutboundAttachments(outbound.attachments, {
        baseDirs: options.attachmentBaseDirs,
      });
      const files = validation.files;

      if (validation.rejected.length > 0) {
        logger.warn(
          {
            jid,
            channelName: this.name,
            attachmentSource: outbound.attachmentSource,
            rejected: validation.rejected,
          },
          'Rejected outbound Discord attachments',
        );
      }

      let cleaned = outbound.cleanText
        .replace(/^[ \t]*[•*-][ \t]*$/gm, '') // remove empty bullet lines
        .replace(/\n{3,}/g, '\n\n') // collapse excessive blank lines
        .trim();

      // Convert @username mentions to Discord mention format
      const mentionMap: Record<string, string> = {
        눈쟁이: '216851709744513024',
      };
      for (const [name, id] of Object.entries(mentionMap)) {
        cleaned = cleaned.replace(new RegExp(`@${name}`, 'g'), `<@${id}>`);
      }
      cleaned = formatOutbound(cleaned);

      // Discord has a 2000 character limit per message and 10 attachments per message
      const MAX_LENGTH = 2000;
      const MAX_ATTACHMENTS = 10;
      const sentMessageIds: string[] = [];
      let chunkCount = 0;

      const recordSentMessage = (message: Message | null | undefined) => {
        chunkCount += 1;
        if (message?.id) sentMessageIds.push(message.id);
      };

      if (!cleaned && files.length === 0) {
        logger.debug(
          { jid, channelName: this.name },
          'Skipping empty Discord outbound message',
        );
        return { primaryMessageId: null, messageIds: [], visible: false };
      }

      // Split files into batches of MAX_ATTACHMENTS
      const fileBatches: (typeof files)[] = [];
      for (let i = 0; i < files.length; i += MAX_ATTACHMENTS) {
        fileBatches.push(files.slice(i, i + MAX_ATTACHMENTS));
      }

      if (cleaned.length <= MAX_LENGTH) {
        // Send text with first batch of files
        recordSentMessage(
          await textChannel.send({
            content: cleaned || undefined,
            files: fileBatches[0]?.length ? fileBatches[0] : undefined,
            flags: MessageFlags.SuppressEmbeds,
          }),
        );
        // Send remaining file batches as follow-up messages
        for (let b = 1; b < fileBatches.length; b++) {
          recordSentMessage(
            await textChannel.send({
              files: fileBatches[b],
              flags: MessageFlags.SuppressEmbeds,
            }),
          );
        }
      } else {
        // Send text in chunks, attach first batch to the first chunk
        let fileBatchIndex = 0;
        for (let i = 0; i < cleaned.length; i += MAX_LENGTH) {
          const chunk = cleaned.slice(i, i + MAX_LENGTH);
          const batch = fileBatches[fileBatchIndex];
          recordSentMessage(
            await textChannel.send({
              content: chunk,
              files: batch?.length ? batch : undefined,
              flags: MessageFlags.SuppressEmbeds,
            }),
          );
          if (batch?.length) fileBatchIndex++;
        }
        // Send any remaining file batches
        for (let b = fileBatchIndex; b < fileBatches.length; b++) {
          recordSentMessage(
            await textChannel.send({
              files: fileBatches[b],
              flags: MessageFlags.SuppressEmbeds,
            }),
          );
        }
      }
      logger.info(
        {
          jid,
          channelName: this.name,
          length: outbound.text.length,
          deliveryMode: 'send',
          chunkCount,
          attachmentCount: files.length,
          attachmentSource: outbound.attachmentSource,
          messageId: sentMessageIds[0] ?? null,
          messageIds: sentMessageIds,
          botUserId: this.client.user?.id ?? null,
          botUsername: this.client.user?.username ?? null,
        },
        'Discord message sent',
      );
      return {
        primaryMessageId: sentMessageIds[0] ?? null,
        messageIds: sentMessageIds,
        visible: chunkCount > 0,
      };
    } catch (err) {
      logger.error(
        { jid, channelName: this.name, err },
        'Failed to send Discord message',
      );
      throw err;
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  isOwnMessage(msg: NewMessage): boolean {
    return !!msg.is_bot_message && msg.sender === this.client?.user?.id;
  }

  ownsJid(jid: string): boolean {
    if (!jid.startsWith('dc:')) return false;
    if (!this.ownsDiscordJids) return false;
    if (!this.agentTypeFilter) return true;
    const group = this.opts.roomBindings()[jid];
    if (!group) return false;
    const groupType = group.agentType || 'claude-code';
    return groupType === this.agentTypeFilter;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;

    const generation = (this.typingGenerations.get(jid) ?? 0) + 1;
    this.typingGenerations.set(jid, generation);

    // Clear any existing interval for this channel
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!isTyping) return;

    const isCurrentGeneration = () =>
      this.typingGenerations.get(jid) === generation;

    const sendOnce = async () => {
      if (!isCurrentGeneration()) return;
      try {
        const channelId = jid.replace(/^dc:/, '');
        const channel = await this.client!.channels.fetch(channelId);
        if (!isCurrentGeneration()) return;
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
      }
    };

    // Send immediately, then refresh every 8 seconds (Discord expires at ~10s)
    await sendOnce();
    if (!isCurrentGeneration()) return;
    this.typingIntervals.set(
      jid,
      setInterval(() => {
        void sendOnce();
      }, 8000),
    );
  }

  async sendAndTrack(jid: string, text: string): Promise<string | null> {
    if (!this.client) {
      throw new Error('Discord client not initialized');
    }
    try {
      const channelId = jid.replace(/^dc:/, '');
      if (isDashboardTrackedSend(jid, text)) {
        this.dashboardTrackedSendGraceUntil =
          Date.now() + DASHBOARD_TRACKED_SEND_GRACE_MS;
      }
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        throw new Error(`Discord channel not found or not text-based: ${jid}`);
      }
      const msg = await (channel as TextChannel).send(text);
      logger.info(
        {
          jid,
          channelName: this.name,
          deliveryMode: 'tracked-send',
          messageId: msg.id,
          botUserId: this.client.user?.id ?? null,
          botUsername: this.client.user?.username ?? null,
          length: text.length,
        },
        'Discord tracked message sent',
      );
      return msg.id;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send tracked Discord message');
      throw err;
    }
  }

  getOutboundAuditMeta() {
    return {
      channelName: this.name,
      botUserId: this.client?.user?.id ?? null,
      botUsername: this.client?.user?.username ?? null,
    };
  }

  async getChannelMeta(jids: string[]): Promise<Map<string, ChannelMeta>> {
    const result = new Map<string, ChannelMeta>();
    if (!this.client) return result;

    const dcJids = jids.filter((j) => j.startsWith('dc:'));
    if (dcJids.length === 0) return result;

    const channelIdToJid = new Map<string, string>();
    for (const jid of dcJids) {
      channelIdToJid.set(jid.replace(/^dc:/, ''), jid);
    }

    try {
      // Fetch one channel to discover its guild, then batch-fetch all channels
      const firstId = dcJids[0].replace(/^dc:/, '');
      const firstChannel = await this.client.channels.fetch(firstId);
      if (!firstChannel || !('guild' in firstChannel)) return result;

      const guild = (firstChannel as TextChannel).guild;
      const allChannels = await guild.channels.fetch();

      for (const [id, channel] of allChannels) {
        const jid = channelIdToJid.get(id);
        if (!jid || !channel) continue;
        result.set(jid, {
          name: channel.name,
          position: channel.position,
          category: channel.parent?.name || '',
          categoryPosition: channel.parent?.position ?? 999,
        });
      }
    } catch {
      // Fallback: individual fetches
      for (const jid of dcJids) {
        try {
          const channelId = jid.replace(/^dc:/, '');
          const channel = await this.client.channels.fetch(channelId);
          if (channel && 'position' in channel) {
            const tc = channel as TextChannel;
            result.set(jid, {
              name: tc.name,
              position: tc.position,
              category: tc.parent?.name || '',
              categoryPosition: tc.parent?.position ?? 999,
            });
          }
        } catch {
          /* skip inaccessible channels */
        }
      }
    }

    return result;
  }

  async purgeChannel(jid: string): Promise<number> {
    if (!this.client) return 0;
    let deleted = 0;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('bulkDelete' in channel)) return 0;
      const tc = channel as TextChannel;

      // Fetch and delete in batches (bulkDelete handles up to 100, only < 14 days old)
      let hasMore = true;
      while (hasMore) {
        const messages = await tc.messages.fetch({ limit: 100 });
        if (messages.size === 0) break;

        // Separate into bulk-deletable (< 14 days) and old messages
        const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const recent = messages.filter((m) => m.createdTimestamp > twoWeeksAgo);
        const old = messages.filter((m) => m.createdTimestamp <= twoWeeksAgo);

        if (recent.size >= 2) {
          await tc.bulkDelete(recent);
          deleted += recent.size;
        } else if (recent.size === 1) {
          await recent.first()!.delete();
          deleted += 1;
        }

        for (const [, msg] of old) {
          await msg.delete();
          deleted += 1;
        }

        hasMore = messages.size === 100;
      }

      logger.info({ jid, deleted }, 'Purged channel messages');
    } catch (err) {
      logger.error({ jid, err, deleted }, 'Failed to purge channel messages');
    }
    return deleted;
  }

  async deleteRecentMessagesByContent(
    jid: string,
    options: DeleteRecentMessagesByContentOptions,
  ): Promise<number> {
    return deleteRecentDiscordMessagesByContent({
      client: this.client,
      channelName: this.name,
      jid,
      options,
    });
  }

  async editMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Discord client not initialized');
    }
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) {
        throw new Error(`Discord channel not found or not editable: ${jid}`);
      }
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.edit(text);
      logger.info(
        {
          jid,
          channelName: this.name,
          deliveryMode: 'edit',
          messageId,
          length: text.length,
          botUserId: this.client.user?.id ?? null,
          botUsername: this.client.user?.username ?? null,
        },
        'Discord message edited',
      );
    } catch (err) {
      logger.debug(
        {
          jid,
          channelName: this.name,
          messageId,
          botUserId: this.client?.user?.id ?? null,
          botUsername: this.client?.user?.username ?? null,
          err,
        },
        'Failed to edit Discord message',
      );
      throw err; // Re-throw so callers (e.g. dashboard) can reset message ID
    }
  }
}

registerChannel(DISCORD_OWNER_CHANNEL, (opts: ChannelOpts) => {
  const token = getEnv(DISCORD_OWNER_TOKEN_KEY) || '';
  if (!token) {
    logger.warn('Discord: DISCORD_OWNER_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts, undefined, DISCORD_OWNER_CHANNEL);
});

registerChannel(DISCORD_REVIEWER_CHANNEL, (opts: ChannelOpts) => {
  const ownerToken = getEnv(DISCORD_OWNER_TOKEN_KEY) || '';
  const token = getEnv(DISCORD_REVIEWER_TOKEN_KEY) || '';
  if (!token) return null;
  if (token === ownerToken) {
    logger.warn(
      'Discord: reviewer bot token matches owner bot token; skipping duplicate reviewer bot login',
    );
    return null;
  }
  return new DiscordChannel(
    token,
    opts,
    undefined,
    DISCORD_REVIEWER_CHANNEL,
    false,
    false,
  );
});

registerChannel(DISCORD_ARBITER_CHANNEL, (opts: ChannelOpts) => {
  const ownerToken = getEnv(DISCORD_OWNER_TOKEN_KEY) || '';
  const reviewerToken = getEnv(DISCORD_REVIEWER_TOKEN_KEY) || '';
  const token = getEnv(DISCORD_ARBITER_TOKEN_KEY) || '';
  if (!token) return null;
  if (token === ownerToken || token === reviewerToken) {
    logger.warn(
      'Discord: arbiter bot token matches another role token; skipping duplicate arbiter bot login',
    );
    return null;
  }
  return new DiscordChannel(
    token,
    opts,
    undefined,
    DISCORD_ARBITER_CHANNEL,
    false,
    false,
  );
});
