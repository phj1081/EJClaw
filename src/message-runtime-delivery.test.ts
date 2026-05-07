import { describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  markWorkItemDelivered: vi.fn(),
  markWorkItemDeliveryRetry: vi.fn(),
}));

import { markWorkItemDelivered } from './db.js';
import { deliverOpenWorkItem } from './message-runtime-delivery.js';
import type { WorkItem } from './db/work-items.js';
import type { Channel } from './types.js';

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 123,
    group_folder: 'room-folder',
    chat_jid: 'dc:room',
    agent_type: 'codex',
    service_id: 'codex-main',
    delivery_role: 'owner',
    status: 'produced',
    start_seq: null,
    end_seq: null,
    result_payload:
      'TASK_DONE 캡처입니다.\n![image](/home/ejclaw/EJClaw/data/artifacts/smoke.png)',
    attachments: [],
    delivery_attempts: 0,
    delivery_message_id: null,
    last_error: null,
    created_at: '2026-05-07T00:00:00.000Z',
    updated_at: '2026-05-07T00:00:00.000Z',
    delivered_at: null,
    ...overrides,
  };
}

function makeChannel(): Channel {
  return {
    name: 'discord',
    connect: vi.fn(),
    sendMessage: vi.fn(async () => ({
      primaryMessageId: 'discord-message-1',
      messageIds: ['discord-message-1'],
      visible: true,
    })),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    disconnect: vi.fn(),
  } as unknown as Channel;
}

describe('deliverOpenWorkItem', () => {
  it('passes attachment base dirs for text-only messages so markdown images can be uploaded', async () => {
    const channel = makeChannel();
    const attachmentBaseDirs = [
      '/home/ejclaw/EJClaw/data/artifacts',
      '/home/ejclaw/EJClaw/data/workspaces/simsimeee',
    ];

    await expect(
      deliverOpenWorkItem({
        channel,
        item: makeWorkItem(),
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        attachmentBaseDirs,
        isDuplicateOfLastBotFinal: vi.fn(() => false),
        openContinuation: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(channel.sendMessage).toHaveBeenCalledWith(
      'dc:room',
      expect.stringContaining('![image]('),
      {
        attachmentBaseDirs,
      },
    );
    expect(markWorkItemDelivered).toHaveBeenCalledWith(
      123,
      'discord-message-1',
    );
  });
});
