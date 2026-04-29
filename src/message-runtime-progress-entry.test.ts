import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  executeTurn: vi.fn(async () => ({
    outputStatus: 'success' as const,
    deliverySucceeded: true,
    visiblePhase: 'progress' as const,
  })),
}));

vi.mock('./message-runtime-turns.js', () => ({
  createRunAgent: vi.fn(() => vi.fn()),
  createExecuteTurn: vi.fn(() => runtimeMocks.executeTurn),
  isDuplicateOfLastBotFinal: vi.fn(() => false),
  labelPairedSenders: vi.fn((_channels, _chatJid, messages) => messages),
}));

import {
  _initTestDatabase,
  _setRegisteredGroupForTests,
  getLatestOpenPairedTaskForChat,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { createMessageRuntime } from './message-runtime.js';
import {
  clearGlobalFailover,
  refreshChannelOwnerCache,
} from './service-routing.js';
import type { Channel, RegisteredGroup } from './types.js';

const chatJid = 'group@test';
const timestamp = '2026-04-30T00:30:00.000Z';

function makeGroup(): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: timestamp,
    requiresTrigger: false,
    agentType: 'codex',
    workDir: process.cwd(),
  };
}

function makeChannel(name: string, ownsJid: boolean): Channel {
  return {
    name,
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => ownsJid && jid === chatJid),
    disconnect: vi.fn(),
    setTyping: vi.fn(),
  } as unknown as Channel;
}

describe('message-runtime progress entry path', () => {
  beforeEach(() => {
    _initTestDatabase();
    refreshChannelOwnerCache(true);
    clearGlobalFailover();
    runtimeMocks.executeTurn.mockClear();
    runtimeMocks.executeTurn.mockResolvedValue({
      outputStatus: 'success',
      deliverySucceeded: true,
      visiblePhase: 'progress',
    });
  });

  it('passes pairedTurnIdentity through the production owner-turn entry path when no task is open', async () => {
    const group = makeGroup();
    const ownerChannel = makeChannel('discord', true);
    const reviewerChannel = makeChannel('discord-review', false);
    const lastAgentTimestamps: Record<string, string> = {};
    const saveState = vi.fn();

    _setRegisteredGroupForTests(chatJid, {
      ...group,
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests(chatJid, group);
    refreshChannelOwnerCache(true);
    storeChatMetadata(chatJid, timestamp, 'Test Group');
    storeMessage({
      id: 'human-first-owner-turn',
      chat_jid: chatJid,
      sender: 'user@test',
      sender_name: 'User',
      content: '디스코드에는 progress가 보이는데 사이트에는 안 보여요',
      timestamp,
      is_bot_message: false,
      is_from_me: false,
    });

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [ownerChannel, reviewerChannel],
      queue: {
        enqueueMessageCheck: vi.fn(),
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRoomBindings: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-first-owner-entry',
      reason: 'messages',
    });

    const freshTask = getLatestOpenPairedTaskForChat(chatJid);
    expect(result).toBe(true);
    expect(freshTask).toBeDefined();
    expect(runtimeMocks.executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryRole: 'owner',
        forcedRole: 'owner',
        pairedTurnIdentity: {
          turnId: `${freshTask!.id}:${freshTask!.updated_at}:owner-turn`,
          taskId: freshTask!.id,
          taskUpdatedAt: freshTask!.updated_at,
          intentKind: 'owner-turn',
          role: 'owner',
        },
      }),
    );
    expect(lastAgentTimestamps).toEqual({ [chatJid]: '1' });
    expect(saveState).toHaveBeenCalled();
  });
});
