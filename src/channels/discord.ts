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

import {
  ASSISTANT_NAME,
  CACHE_DIR,
  DATA_DIR,
  TRIGGER_PATTERN,
} from '../config.js';
import { getEnv } from '../env.js';
import { logger } from '../logger.js';
import { formatOutbound } from '../router.js';
import { hasReviewerLease } from '../service-routing.js';

const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const TRANSCRIPTION_CACHE_DIR = path.join(CACHE_DIR, 'transcriptions');

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
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private typingIntervals = new Map<string, NodeJS.Timeout>();
  private typingGenerations = new Map<string, number>();
  private agentTypeFilter?: AgentType;

  constructor(
    botToken: string,
    opts: DiscordChannelOpts,
    agentTypeFilter?: AgentType,
    channelName?: string,
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.agentTypeFilter = agentTypeFilter;
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
      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      const isOwnBotMessage = message.author.id === this.client?.user?.id;
      if (isOwnBotMessage) return;
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

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
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
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups matching our agent type
      const group = this.opts.registeredGroups()[chatJid];
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

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Extract image attachments from markdown links with image extensions
      // e.g. [name.png](/absolute/path/name.png)
      const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
      const MD_LINK_RE = /\[[^\]]*\]\((\/[^)]+)\)/g;
      const imageFiles: string[] = [];
      const seen = new Set<string>();
      let match;

      while ((match = MD_LINK_RE.exec(text)) !== null) {
        const imgPath = match[1].trim();
        if (
          !seen.has(imgPath) &&
          IMAGE_EXTS.test(imgPath) &&
          fs.existsSync(imgPath)
        ) {
          imageFiles.push(imgPath);
          seen.add(imgPath);
        }
      }
      let cleaned = text
        .replace(MD_LINK_RE, (full, p, _offset, _str, groups) => {
          const trimmed = p.trim();
          // Image links: remove entirely (attached as files)
          if (IMAGE_EXTS.test(trimmed) && seen.has(trimmed)) return '';
          // Non-image local path links: convert to readable filename
          const basename = path.basename(trimmed.replace(/#.*$/, ''));
          const lineMatch = trimmed.match(/#L(\d+)/);
          return lineMatch
            ? `\`${basename}:${lineMatch[1]}\``
            : `\`${basename}\``;
        })
        .replace(/^[ \t]*[•\-\*][ \t]*$/gm, '') // remove empty bullet lines
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
      const files = imageFiles.map((f) => ({
        attachment: f,
        name: path.basename(f),
      }));

      if (!cleaned && files.length === 0) {
        logger.debug({ jid }, 'Skipping empty Discord outbound message');
        return;
      }

      // Split files into batches of MAX_ATTACHMENTS
      const fileBatches: (typeof files)[] = [];
      for (let i = 0; i < files.length; i += MAX_ATTACHMENTS) {
        fileBatches.push(files.slice(i, i + MAX_ATTACHMENTS));
      }

      if (cleaned.length <= MAX_LENGTH) {
        // Send text with first batch of files
        await textChannel.send({
          content: cleaned || undefined,
          files: fileBatches[0]?.length ? fileBatches[0] : undefined,
          flags: MessageFlags.SuppressEmbeds,
        });
        // Send remaining file batches as follow-up messages
        for (let b = 1; b < fileBatches.length; b++) {
          await textChannel.send({
            files: fileBatches[b],
            flags: MessageFlags.SuppressEmbeds,
          });
        }
      } else {
        // Send text in chunks, attach first batch to the first chunk
        let fileBatchIndex = 0;
        for (let i = 0; i < cleaned.length; i += MAX_LENGTH) {
          const chunk = cleaned.slice(i, i + MAX_LENGTH);
          const batch = fileBatches[fileBatchIndex];
          await textChannel.send({
            content: chunk,
            files: batch?.length ? batch : undefined,
            flags: MessageFlags.SuppressEmbeds,
          });
          if (batch?.length) fileBatchIndex++;
        }
        // Send any remaining file batches
        for (let b = fileBatchIndex; b < fileBatches.length; b++) {
          await textChannel.send({
            files: fileBatches[b],
            flags: MessageFlags.SuppressEmbeds,
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
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
    if (!this.agentTypeFilter) return true;
    const group = this.opts.registeredGroups()[jid];
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
    if (!this.client) return null;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return null;
      const msg = await (channel as TextChannel).send(text);
      return msg.id;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send tracked Discord message');
      throw err;
    }
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

  async editMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.edit(text);
    } catch (err) {
      logger.debug({ jid, messageId, err }, 'Failed to edit Discord message');
      throw err; // Re-throw so callers (e.g. dashboard) can reset message ID
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const token = getEnv('DISCORD_BOT_TOKEN') || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  // If a second Codex bot token exists, this instance only handles claude-code groups
  const hasCodexBot = !!getEnv('DISCORD_CODEX_BOT_TOKEN');
  return new DiscordChannel(
    token,
    opts,
    hasCodexBot ? 'claude-code' : undefined,
    'discord',
  );
});

// Register the secondary Codex bot channel.
registerChannel('discord-codex', (opts: ChannelOpts) => {
  const token = getEnv('DISCORD_CODEX_BOT_TOKEN') || '';
  if (!token) return null;
  return new DiscordChannel(token, opts, 'codex', 'discord-codex');
});

// Register the review bot channel (codex agent type, separate token).
registerChannel('discord-review', (opts: ChannelOpts) => {
  const token = getEnv('DISCORD_REVIEW_BOT_TOKEN') || '';
  if (!token) return null;
  return new DiscordChannel(token, opts, 'codex', 'discord-review');
});
