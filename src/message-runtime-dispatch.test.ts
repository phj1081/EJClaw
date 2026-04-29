import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  getLastHumanMessageTimestamp: vi.fn(() => null),
  getLatestOpenPairedTaskForChat: vi.fn(() => null),
  getMessagesSinceSeq: vi.fn(() => []),
  getPairedTurnOutputs: vi.fn(() => []),
}));

vi.mock('./service-routing.js', () => ({
  hasReviewerLease: vi.fn(() => false),
  resolveLeaseServiceId: vi.fn(() => null),
}));

import { getLastHumanMessageTimestamp } from './db.js';
import { processLoopGroupMessages } from './message-runtime-dispatch.js';
import { hasReviewerLease } from './service-routing.js';
import type { Channel, NewMessage, RegisteredGroup } from './types.js';

const getLastHumanMessageTimestampMock =
  getLastHumanMessageTimestamp as unknown as {
    mockReturnValue(value: string | null): void;
  };
const hasReviewerLeaseMock = hasReviewerLease as unknown as {
  mockReturnValue(value: boolean): void;
};

const chatJid = 'group@test';
const timestamp = '2026-04-29T13:25:28.000Z';

const group: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: timestamp,
  requiresTrigger: false,
};

const channel: Channel = {
  name: 'discord',
  connect: vi.fn(),
  sendMessage: vi.fn(),
  isConnected: vi.fn(() => true),
  ownsJid: vi.fn(() => true),
  disconnect: vi.fn(),
};

function message(overrides: Partial<NewMessage>): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: chatJid,
    sender: 'user',
    sender_name: 'User',
    content: '중간에 이거 먼저 봐줘',
    timestamp,
    seq: 10,
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

function defaultArgs(
  overrides: Partial<Parameters<typeof processLoopGroupMessages>[0]> = {},
) {
  return {
    chatJid,
    group,
    groupMessages: [message({})],
    channel,
    assistantName: '오너',
    failureFinalText: 'FAILED',
    triggerPattern: /^\/clear\b/,
    hasImplicitContinuationWindow: vi.fn(() => false),
    lastAgentTimestamps: {},
    saveState: vi.fn(),
    timezone: 'Asia/Seoul',
    executeTurn: vi.fn(),
    schedulePairedFollowUp: vi.fn(() => true),
    enqueueMessageCheck: vi.fn(),
    sendQueuedMessage: vi.fn(() => true),
    closeStdin: vi.fn(),
    isRunningMessageTurn: vi.fn(() => true),
    labelPairedSenders: vi.fn((_jid, messages) => messages),
    formatMessages: vi.fn((messages: NewMessage[]) =>
      messages.map((item) => item.content).join('\n'),
    ),
    ...overrides,
  } satisfies Parameters<typeof processLoopGroupMessages>[0];
}

describe('processLoopGroupMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLastHumanMessageTimestampMock.mockReturnValue(null);
    hasReviewerLeaseMock.mockReturnValue(false);
  });

  it('requeues external human messages instead of piping them into an active agent', async () => {
    const args = defaultArgs();

    await processLoopGroupMessages(args);

    expect(args.closeStdin).toHaveBeenCalledWith('human-message-detected');
    expect(args.enqueueMessageCheck).toHaveBeenCalledTimes(1);
    expect(args.sendQueuedMessage).not.toHaveBeenCalled();
    expect(args.lastAgentTimestamps).toEqual({});
    expect(args.saveState).not.toHaveBeenCalled();
  });

  it('does not close stdin for human messages when no message turn is running', async () => {
    const args = defaultArgs({
      isRunningMessageTurn: vi.fn(() => false),
    });

    await processLoopGroupMessages(args);

    expect(args.closeStdin).not.toHaveBeenCalled();
    expect(args.enqueueMessageCheck).toHaveBeenCalledTimes(1);
    expect(args.sendQueuedMessage).not.toHaveBeenCalled();
  });

  it('still pipes bot-only messages when active stdin accepts them', async () => {
    hasReviewerLeaseMock.mockReturnValue(true);
    getLastHumanMessageTimestampMock.mockReturnValue(timestamp);
    const args = defaultArgs({
      groupMessages: [
        message({
          id: 'bot-msg-1',
          sender: '오너',
          sender_name: '오너',
          content: 'STEP_DONE',
          is_from_me: true,
          is_bot_message: true,
          seq: 12,
        }),
      ],
    });

    await processLoopGroupMessages(args);

    expect(args.sendQueuedMessage).toHaveBeenCalledWith(chatJid, 'STEP_DONE');
    expect(args.closeStdin).not.toHaveBeenCalled();
    expect(args.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(args.lastAgentTimestamps).toEqual({ [chatJid]: '12' });
  });
});
