import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  createProducedWorkItem: vi.fn((args) => ({
    id: 123,
    chat_jid: args.chat_jid,
    delivery_role: args.delivery_role,
    result_payload: args.result_payload,
    attachments: args.attachments,
    delivery_attempts: 0,
  })),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./message-runtime-delivery.js', () => ({
  deliverOpenWorkItem: vi.fn(() => Promise.resolve(true)),
}));

import { createProducedWorkItem } from './db.js';
import { logger } from './logger.js';
import { deliverOpenWorkItem } from './message-runtime-delivery.js';
import { deliverMessageRuntimeFinalText } from './message-runtime-final-delivery.js';
import type { Channel, RegisteredGroup } from './types.js';

function makeChannel(): Channel {
  return {
    name: 'discord-owner',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    disconnect: vi.fn(),
  } as unknown as Channel;
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Room',
    folder: 'room-folder',
    added_at: '2026-04-29T01:00:00.000Z',
    ...overrides,
  };
}

describe('message-runtime-final-delivery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(deliverOpenWorkItem).mockResolvedValue(true);
    vi.mocked(createProducedWorkItem).mockImplementation(
      (args: any) =>
        ({
          id: 123,
          chat_jid: args.chat_jid,
          delivery_role: args.delivery_role,
          result_payload: args.result_payload,
          attachments: args.attachments,
          delivery_attempts: 0,
        }) as any,
    );
  });

  it.each(['reviewer', 'arbiter'] as const)(
    'skips %s work item delivery after direct terminal IPC delivery',
    async (deliveryRole) => {
      const hasDirectTerminalDeliveryForRun = vi.fn(() => true);

      const result = await deliverMessageRuntimeFinalText({
        text: `${deliveryRole} final`,
        chatJid: 'chat-1',
        runId: 'run-1',
        channel: makeChannel(),
        group: makeGroup(),
        startSeq: 10,
        endSeq: 11,
        deliveryRole,
        deliveryServiceId: 'codex-main',
        hasDirectTerminalDeliveryForRun,
        isDuplicateOfLastBotFinal: vi.fn(),
        openContinuation: vi.fn(),
      });

      expect(result).toBe(true);
      expect(hasDirectTerminalDeliveryForRun).toHaveBeenCalledWith(
        'chat-1',
        'run-1',
        deliveryRole,
      );
      expect(createProducedWorkItem).not.toHaveBeenCalled();
      expect(deliverOpenWorkItem).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: 'chat-1',
          runId: 'run-1',
          deliveryRole,
        }),
        'Skipping final work item delivery because this run already sent a direct terminal IPC message',
      );
    },
  );

  it('creates and delivers a produced work item with default agent type and attachment roots', async () => {
    const channel = makeChannel();
    const isDuplicateOfLastBotFinal = vi.fn(() => false);
    const openContinuation = vi.fn();
    const attachments = [
      {
        path: '/tmp/image.png',
        name: 'image.png',
        mime: 'image/png',
      },
    ];

    const result = await deliverMessageRuntimeFinalText({
      text: 'owner final',
      attachments,
      chatJid: 'chat-1',
      runId: 'run-owner',
      channel,
      group: makeGroup({ workDir: '/work/room' }),
      startSeq: 1,
      endSeq: 2,
      deliveryRole: 'owner',
      deliveryServiceId: null,
      hasDirectTerminalDeliveryForRun: vi.fn(() => true),
      isDuplicateOfLastBotFinal,
      openContinuation,
    });

    expect(result).toBe(true);
    expect(createProducedWorkItem).toHaveBeenCalledWith({
      group_folder: 'room-folder',
      chat_jid: 'chat-1',
      agent_type: 'claude-code',
      service_id: undefined,
      delivery_role: 'owner',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'owner final',
      attachments,
    });
    expect(deliverOpenWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        channel,
        log: logger,
        attachmentBaseDirs: expect.arrayContaining([
          '/work/room',
          expect.stringMatching(/data\/workspaces\/room-folder$/),
        ]),
        replaceMessageId: undefined,
        isDuplicateOfLastBotFinal,
        openContinuation,
      }),
    );
  });

  it('preserves forced agent, delivery service, and replacement message metadata', async () => {
    const channel = makeChannel();

    await deliverMessageRuntimeFinalText({
      text: 'forced final',
      chatJid: 'chat-1',
      runId: 'run-forced',
      channel,
      group: makeGroup({ agentType: 'claude-code' }),
      startSeq: null,
      endSeq: null,
      forcedAgentType: 'codex',
      deliveryRole: 'arbiter',
      deliveryServiceId: 'codex-main',
      replaceMessageId: 'discord-message-1',
      hasDirectTerminalDeliveryForRun: vi.fn(() => false),
      isDuplicateOfLastBotFinal: vi.fn(),
      openContinuation: vi.fn(),
    });

    expect(createProducedWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_type: 'codex',
        service_id: 'codex-main',
        delivery_role: 'arbiter',
        start_seq: null,
        end_seq: null,
      }),
    );
    expect(deliverOpenWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        replaceMessageId: 'discord-message-1',
        attachmentBaseDirs: expect.arrayContaining([
          expect.stringMatching(/data\/workspaces\/room-folder$/),
        ]),
      }),
    );
  });

  it('returns the deliverOpenWorkItem result', async () => {
    vi.mocked(deliverOpenWorkItem).mockResolvedValue(false);

    await expect(
      deliverMessageRuntimeFinalText({
        text: 'failed final',
        chatJid: 'chat-1',
        runId: 'run-failed',
        channel: makeChannel(),
        group: makeGroup(),
        startSeq: 1,
        endSeq: 2,
        deliveryRole: null,
        deliveryServiceId: null,
        isDuplicateOfLastBotFinal: vi.fn(),
        openContinuation: vi.fn(),
      }),
    ).resolves.toBe(false);
  });
});
