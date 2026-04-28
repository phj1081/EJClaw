import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', () => ({
  registerChannel: vi.fn(),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
  getEnv: vi.fn(() => undefined),
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  DATA_DIR: '/tmp/ejclaw-test-data',
  CACHE_DIR: '/tmp/ejclaw-test-cache',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../service-routing.js', () => ({
  hasReviewerLease: vi.fn(() => false),
}));

type Handler = (...args: any[]) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('discord.js', () => {
  class MockClient {
    eventHandlers = new Map<string, Handler[]>();
    user: any = { id: '999888777', tag: 'Andy#1234' };
    private _ready = false;

    constructor(_opts: any) {
      clientRef.current = this;
    }

    on(event: string, handler: Handler) {
      this.eventHandlers.set(event, [
        ...(this.eventHandlers.get(event) ?? []),
        handler,
      ]);
      return this;
    }

    once(event: string, handler: Handler) {
      return this.on(event, handler);
    }

    async login(_token: string) {
      this._ready = true;
      for (const handler of this.eventHandlers.get('ready') ?? []) {
        handler({ user: this.user });
      }
    }

    isReady() {
      return this._ready;
    }

    channels = {
      fetch: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      }),
    };
  }

  return {
    Client: MockClient,
    Events: {
      MessageCreate: 'messageCreate',
      ClientReady: 'ready',
      Error: 'error',
    },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      DirectMessages: 8,
    },
    MessageFlags: { SuppressEmbeds: 1 << 2, IsVoiceMessage: 1 << 13 },
    TextChannel: class TextChannel {},
  };
});

import { DiscordChannel, type DiscordChannelOpts } from './discord.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const tempFiles: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const file of tempFiles.splice(0)) {
    fs.rmSync(file, { force: true });
  }
});

function createTestOpts(): DiscordChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    roomBindings: vi.fn(() => ({})),
  };
}

describe('DiscordChannel structured output', () => {
  it('normalizes raw EJClaw JSON and sends direct temp images as files', async () => {
    const channel = new DiscordChannel('test-token', createTestOpts());
    await channel.connect();
    const filePath = path.join(
      os.tmpdir(),
      `bar-chart-label-fit-playwright-${Date.now()}.png`,
    );
    fs.writeFileSync(filePath, ONE_PIXEL_PNG);
    tempFiles.push(filePath);
    const mockChannel = {
      send: vi.fn().mockResolvedValue({ id: 'discord-message-1' }),
      sendTyping: vi.fn(),
    };
    clientRef.current.channels.fetch.mockResolvedValue(mockChannel);

    const result = await channel.sendMessage(
      'dc:1234567890123456',
      JSON.stringify({
        ejclaw: {
          visibility: 'public',
          text: '라벨 좌측 클리핑 회귀 수정했습니다.',
          verdict: 'done',
          attachments: [
            {
              path: filePath,
              name: 'bar-chart-label-fit-playwright.png',
              mime: 'image/png',
            },
          ],
        },
      }),
    );

    expect(result).toMatchObject({
      primaryMessageId: 'discord-message-1',
      messageIds: ['discord-message-1'],
      visible: true,
    });
    expect(mockChannel.send).toHaveBeenCalledWith({
      content: '라벨 좌측 클리핑 회귀 수정했습니다.',
      files: [
        {
          attachment: fs.realpathSync(filePath),
          name: 'bar-chart-label-fit-playwright.png',
        },
      ],
      flags: 1 << 2,
    });
    expect(JSON.stringify(mockChannel.send.mock.calls)).not.toContain(
      '"ejclaw"',
    );
  });
});
