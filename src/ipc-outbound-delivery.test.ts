import { describe, expect, it, vi } from 'vitest';

import {
  deliverCanonicalOutboundMessage,
  deliverIpcOutboundMessage,
} from './ipc-outbound-delivery.js';
import type { WorkItem } from './db/work-items.js';
import type { Channel, RegisteredGroup } from './types.js';

function makeChannel(name = 'discord', owns = true): Channel {
  return {
    name,
    connect: async () => {},
    sendMessage: vi.fn(async () => {}),
    isConnected: () => true,
    ownsJid: () => owns,
    disconnect: async () => {},
  };
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Room',
    folder: 'room-folder',
    added_at: '2026-04-28T00:00:00.000Z',
    agentType: 'codex',
    workDir: '/repo',
    ...overrides,
  };
}

function makeWorkItem(input: {
  chat_jid: string;
  group_folder: string;
  agent_type?: WorkItem['agent_type'];
  delivery_role?: WorkItem['delivery_role'];
  result_payload: string;
  attachments?: WorkItem['attachments'];
}): WorkItem {
  return {
    id: 123,
    group_folder: input.group_folder,
    chat_jid: input.chat_jid,
    agent_type: input.agent_type ?? 'codex',
    service_id: 'codex-main',
    delivery_role: input.delivery_role ?? null,
    status: 'produced',
    start_seq: null,
    end_seq: null,
    result_payload: input.result_payload,
    attachments: input.attachments ?? [],
    delivery_attempts: 0,
    delivery_message_id: null,
    last_error: null,
    created_at: '2026-04-28T00:00:00.000Z',
    updated_at: '2026-04-28T00:00:00.000Z',
    delivered_at: null,
  };
}

describe('deliverIpcOutboundMessage', () => {
  it('funnels ordinary outbound through canonical work item delivery', async () => {
    const channel = makeChannel();
    const createdItem = makeWorkItem({
      chat_jid: 'dc:room',
      group_folder: 'room-folder',
      result_payload: '일반 안내',
    });
    const createWorkItem = vi.fn(() => createdItem);
    const deliverWorkItem = vi.fn(async () => true);

    const result = await deliverCanonicalOutboundMessage(
      { jid: 'dc:room', text: '일반 안내' },
      {
        channels: [channel],
        roomBindings: () => ({ 'dc:room': makeGroup() }),
        createWorkItem,
        deliverWorkItem,
      },
    );

    expect(result).toBe('delivered');
    expect(createWorkItem).toHaveBeenCalledWith({
      group_folder: 'room-folder',
      chat_jid: 'dc:room',
      agent_type: 'codex',
      delivery_role: null,
      start_seq: null,
      end_seq: null,
      result_payload: '일반 안내',
      attachments: undefined,
    });
    expect(deliverWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        channel,
        item: createdItem,
        attachmentBaseDirs: expect.arrayContaining([
          '/repo',
          expect.stringMatching(/data\/workspaces\/room-folder$/),
        ]),
      }),
    );
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('funnels IPC outbound through canonical work item delivery', async () => {
    const ownerChannel = makeChannel();
    const reviewerChannel = makeChannel('discord-review', false);
    const createdItem = makeWorkItem({
      chat_jid: 'dc:room',
      group_folder: 'room-folder',
      delivery_role: 'reviewer',
      result_payload: 'TASK_DONE\n검증 완료',
    });
    const createWorkItem = vi.fn(() => createdItem);
    const deliverWorkItem = vi.fn(async () => true);
    const noteDirectTerminalDelivery = vi.fn();

    const result = await deliverIpcOutboundMessage(
      {
        jid: 'dc:room',
        text: 'TASK_DONE\n검증 완료',
        senderRole: 'reviewer',
        runId: 'run-1',
      },
      {
        channels: [ownerChannel, reviewerChannel],
        roomBindings: () => ({ 'dc:room': makeGroup() }),
        queue: { noteDirectTerminalDelivery },
        createWorkItem,
        deliverWorkItem,
      },
    );

    expect(result).toBe('delivered');
    expect(createWorkItem).toHaveBeenCalledWith({
      group_folder: 'room-folder',
      chat_jid: 'dc:room',
      agent_type: 'codex',
      delivery_role: 'reviewer',
      start_seq: null,
      end_seq: null,
      result_payload: 'TASK_DONE\n검증 완료',
      attachments: undefined,
    });
    expect(deliverWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: reviewerChannel,
        item: createdItem,
        attachmentBaseDirs: expect.arrayContaining([
          '/repo',
          expect.stringMatching(/data\/workspaces\/room-folder$/),
        ]),
      }),
    );
    expect(noteDirectTerminalDelivery).toHaveBeenCalledWith(
      'dc:room',
      'reviewer',
      'TASK_DONE\n검증 완료',
    );
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
    expect(reviewerChannel.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps failed IPC outbound in the delivery retry queue', async () => {
    const channel = makeChannel();
    const createWorkItem = vi.fn((input) => makeWorkItem(input as any));
    const deliverWorkItem = vi.fn(async () => false);
    const noteDirectTerminalDelivery = vi.fn();

    const result = await deliverIpcOutboundMessage(
      {
        jid: 'dc:room',
        text: 'TASK_DONE\n검증 완료',
        senderRole: 'reviewer',
        runId: 'run-1',
      },
      {
        channels: [channel],
        roomBindings: () => ({ 'dc:room': makeGroup() }),
        queue: { noteDirectTerminalDelivery },
        createWorkItem,
        deliverWorkItem,
      },
    );

    expect(result).toBe('queued_retry');
    expect(createWorkItem).toHaveBeenCalledTimes(1);
    expect(deliverWorkItem).toHaveBeenCalledTimes(1);
    expect(noteDirectTerminalDelivery).not.toHaveBeenCalled();
  });

  it('does not create non-canonical outbound for unregistered rooms', async () => {
    const createWorkItem = vi.fn((input) => makeWorkItem(input as any));
    const deliverWorkItem = vi.fn(async () => true);

    await expect(
      deliverIpcOutboundMessage(
        { jid: 'dc:missing', text: 'hello' },
        {
          channels: [makeChannel()],
          roomBindings: () => ({}),
          queue: {},
          createWorkItem,
          deliverWorkItem,
        },
      ),
    ).rejects.toThrow('No registered room binding for outbound JID');

    expect(createWorkItem).not.toHaveBeenCalled();
    expect(deliverWorkItem).not.toHaveBeenCalled();
  });

  it('skips duplicate terminal IPC messages already recorded for the run', async () => {
    const createWorkItem = vi.fn((input) => makeWorkItem(input as any));
    const deliverWorkItem = vi.fn(async () => true);

    const result = await deliverIpcOutboundMessage(
      {
        jid: 'dc:room',
        text: 'TASK_DONE\n검증 완료',
        senderRole: 'reviewer',
        runId: 'run-1',
      },
      {
        channels: [makeChannel()],
        roomBindings: () => ({ 'dc:room': makeGroup() }),
        queue: {
          hasRecordedDirectTerminalDeliveryForRun: () => true,
        },
        createWorkItem,
        deliverWorkItem,
      },
    );

    expect(result).toBe('skipped_recorded_terminal');
    expect(createWorkItem).not.toHaveBeenCalled();
    expect(deliverWorkItem).not.toHaveBeenCalled();
  });
});
