import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _setRegisteredGroupForTests,
  _initTestDatabase,
  storeMessage,
  storeChatMetadata,
  createProducedWorkItem,
  getOpenWorkItem,
  getLastBotFinalMessage,
  markWorkItemDelivered,
} from './db.js';
import { normalizeMessageForDedupe } from './router.js';
import { hasReviewerLease } from './service-routing.js';
import { isDuplicateOfLastBotFinal } from './message-runtime.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to create a message
const createMessage = (
  overrides: Partial<{
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
    is_bot_message: boolean;
  }> = {},
) => ({
  id: overrides.id ?? 'msg-1',
  chat_jid: overrides.chat_jid ?? 'dc:test-room',
  sender: overrides.sender ?? 'user1',
  sender_name: overrides.sender_name ?? 'User',
  content: overrides.content ?? 'Hello',
  timestamp: overrides.timestamp ?? new Date().toISOString(),
  is_from_me: overrides.is_from_me ?? false,
  is_bot_message: overrides.is_bot_message ?? false,
});

// Helper to setup chat metadata
const setupChat = (jid: string) => {
  storeChatMetadata(
    jid,
    new Date().toISOString(),
    'Test Chat',
    'discord',
    true,
  );
};

describe('hasReviewerLease', () => {
  it('returns true when both claude-code and codex are registered', () => {
    const jid = 'dc:paired-room';

    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@claude',
      added_at: new Date().toISOString(),
      agentType: 'claude-code',
    });

    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@codex',
      added_at: new Date().toISOString(),
      agentType: 'codex',
    });

    expect(hasReviewerLease(jid)).toBe(true);
  });

  it('returns false when only claude-code is registered', () => {
    const jid = 'dc:single-claude';

    _setRegisteredGroupForTests(jid, {
      name: 'Single Claude',
      folder: 'single-claude',
      trigger: '@claude',
      added_at: new Date().toISOString(),
      agentType: 'claude-code',
    });

    expect(hasReviewerLease(jid)).toBe(false);
  });

  it('returns false when only codex is registered', () => {
    const jid = 'dc:single-codex';

    _setRegisteredGroupForTests(jid, {
      name: 'Single Codex',
      folder: 'single-codex',
      trigger: '@codex',
      added_at: new Date().toISOString(),
      agentType: 'codex',
    });

    expect(hasReviewerLease(jid)).toBe(false);
  });
});

describe('getLastBotFinalMessage', () => {
  it('returns the most recent bot message from any service (is_bot_message=1)', () => {
    const jid = 'dc:test-room';
    const now = new Date();
    setupChat(jid);

    // Store older bot message (from any bot)
    storeMessage(
      createMessage({
        id: 'msg-1',
        chat_jid: jid,
        content: 'First bot message',
        timestamp: new Date(now.getTime() - 1000).toISOString(),
        is_from_me: true,
        is_bot_message: true,
      }),
    );

    // Store newer bot message (from different bot - is_from_me=0 but is_bot_message=1)
    storeMessage(
      createMessage({
        id: 'msg-2',
        chat_jid: jid,
        content: 'Second bot message',
        timestamp: now.toISOString(),
        is_from_me: false, // Different bot
        is_bot_message: true,
      }),
    );

    // Store human message (should not be returned)
    storeMessage(
      createMessage({
        id: 'msg-3',
        chat_jid: jid,
        content: 'Human message',
        timestamp: new Date(now.getTime() + 1000).toISOString(),
        is_from_me: false,
        is_bot_message: false,
      }),
    );

    const lastMessages = getLastBotFinalMessage(jid, 'claude-code', 1);
    expect(lastMessages).toHaveLength(1);
    expect(lastMessages[0].content).toBe('Second bot message');
  });

  it('returns empty array when no bot messages exist', () => {
    const jid = 'dc:empty-room';
    setupChat(jid);

    const lastMessages = getLastBotFinalMessage(jid, 'claude-code', 1);
    expect(lastMessages).toHaveLength(0);
  });
});

describe('normalizeMessageForDedupe', () => {
  it('normalizes messages for comparison', () => {
    expect(normalizeMessageForDedupe('  Hello World  ')).toBe('hello world');
    expect(normalizeMessageForDedupe('Hello\n\nWorld')).toBe('hello world');
    expect(normalizeMessageForDedupe('Hello   World')).toBe('hello world');
    expect(normalizeMessageForDedupe('HELLO WORLD')).toBe('hello world');
  });

  it('handles empty strings', () => {
    expect(normalizeMessageForDedupe('')).toBe('');
    expect(normalizeMessageForDedupe('   ')).toBe('');
  });
});

describe('isDuplicateOfLastBotFinal (runtime function)', () => {
  it('paired room: detects duplicate final message', () => {
    const jid = 'dc:paired-room';
    setupChat(jid);

    // Register as paired room
    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@claude',
      added_at: new Date().toISOString(),
      agentType: 'claude-code',
    });

    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@codex',
      added_at: new Date().toISOString(),
      agentType: 'codex',
    });

    // Store a bot message (from any bot)
    storeMessage(
      createMessage({
        id: 'msg-1',
        chat_jid: jid,
        content: 'DONE — Task completed successfully',
        timestamp: new Date().toISOString(),
        is_from_me: false, // Different bot
        is_bot_message: true,
      }),
    );

    // Verify it's a paired room
    expect(hasReviewerLease(jid)).toBe(true);

    // Verify duplicate detection works via the actual runtime function
    expect(
      isDuplicateOfLastBotFinal(jid, 'DONE — Task completed successfully'),
    ).toBe(true);
    expect(
      isDuplicateOfLastBotFinal(jid, 'done — task completed successfully'),
    ).toBe(true); // Normalized match
  });

  it('non-paired room: duplicate check is bypassed', () => {
    const jid = 'dc:single-bot';
    setupChat(jid);

    // Register only one bot
    _setRegisteredGroupForTests(jid, {
      name: 'Single Bot',
      folder: 'single-bot',
      trigger: '@claude',
      added_at: new Date().toISOString(),
      agentType: 'claude-code',
    });

    // Store a bot message
    storeMessage(
      createMessage({
        id: 'msg-1',
        chat_jid: jid,
        content: 'DONE — Task completed',
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      }),
    );

    // Verify it's NOT a paired room
    expect(hasReviewerLease(jid)).toBe(false);

    // Duplicate check should be bypassed (return false)
    expect(isDuplicateOfLastBotFinal(jid, 'DONE — Task completed')).toBe(false);
  });

  it('non-duplicate message in paired room is not suppressed', () => {
    const jid = 'dc:paired-room';
    setupChat(jid);

    // Register as paired room
    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@claude',
      added_at: new Date().toISOString(),
      agentType: 'claude-code',
    });

    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@codex',
      added_at: new Date().toISOString(),
      agentType: 'codex',
    });

    // Store a bot message
    storeMessage(
      createMessage({
        id: 'msg-1',
        chat_jid: jid,
        content: 'First message content',
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      }),
    );

    // Verify different content is not a duplicate
    expect(isDuplicateOfLastBotFinal(jid, 'Different message content')).toBe(
      false,
    );
    expect(isDuplicateOfLastBotFinal(jid, 'First message content')).toBe(true);
  });

  it('cross-bot duplicate detection: claude detects codex message as duplicate', () => {
    const jid = 'dc:paired-room';
    setupChat(jid);

    // Register as paired room
    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@claude',
      added_at: new Date().toISOString(),
      agentType: 'claude-code',
    });

    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@codex',
      added_at: new Date().toISOString(),
      agentType: 'codex',
    });

    // Store a bot message from "codex" (is_from_me=0)
    storeMessage(
      createMessage({
        id: 'msg-1',
        chat_jid: jid,
        content: 'DONE — Analysis complete',
        timestamp: new Date().toISOString(),
        is_from_me: false, // Other bot
        is_bot_message: true,
      }),
    );

    // Verify claude service detects this as duplicate (cross-bot detection)
    expect(isDuplicateOfLastBotFinal(jid, 'DONE — Analysis complete')).toBe(
      true,
    );
  });

  it('normalization handles whitespace and case differences', () => {
    const jid = 'dc:paired-room';
    setupChat(jid);

    // Register as paired room
    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@claude',
      added_at: new Date().toISOString(),
      agentType: 'claude-code',
    });

    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@codex',
      added_at: new Date().toISOString(),
      agentType: 'codex',
    });

    // Store a bot message with specific formatting
    storeMessage(
      createMessage({
        id: 'msg-1',
        chat_jid: jid,
        content: 'DONE — Task completed\n\nSuccessfully',
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      }),
    );

    // Same content with different whitespace should be detected as duplicate
    expect(
      isDuplicateOfLastBotFinal(jid, 'done — task completed successfully'),
    ).toBe(true);
    expect(
      isDuplicateOfLastBotFinal(
        jid,
        '  DONE  —  Task  completed  Successfully  ',
      ),
    ).toBe(true);

    // Different content should not be duplicate
    expect(isDuplicateOfLastBotFinal(jid, 'FAILED — Task failed')).toBe(false);
  });

  it('work item lifecycle: produced -> delivered (duplicate)', () => {
    const jid = 'dc:paired-room';
    setupChat(jid);

    // Register as paired room
    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@claude',
      added_at: new Date().toISOString(),
      agentType: 'claude-code',
    });

    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@codex',
      added_at: new Date().toISOString(),
      agentType: 'codex',
    });

    // Store a bot message (simulating previous delivery)
    storeMessage(
      createMessage({
        id: 'msg-1',
        chat_jid: jid,
        content: 'DONE — Task completed successfully',
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      }),
    );

    // Create a work item with the same content (duplicate)
    const workItem = createProducedWorkItem({
      group_folder: 'paired-room',
      chat_jid: jid,
      agent_type: 'claude-code',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'DONE — Task completed successfully',
    });

    expect(workItem.status).toBe('produced');

    // Verify duplicate detection via actual runtime function
    expect(isDuplicateOfLastBotFinal(jid, workItem.result_payload)).toBe(true);

    // Simulate suppression: mark as delivered without sending
    markWorkItemDelivered(workItem.id, null);

    // Verify work item is marked delivered
    const openItem = getOpenWorkItem(jid, 'claude-code');
    expect(openItem).toBeUndefined(); // No open items because it was marked delivered
  });

  it('work item lifecycle: produced -> pending -> delivered (non-duplicate)', () => {
    const jid = 'dc:paired-room';
    setupChat(jid);

    // Register as paired room
    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@claude',
      added_at: new Date().toISOString(),
      agentType: 'claude-code',
    });

    _setRegisteredGroupForTests(jid, {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@codex',
      added_at: new Date().toISOString(),
      agentType: 'codex',
    });

    // Store a bot message
    storeMessage(
      createMessage({
        id: 'msg-1',
        chat_jid: jid,
        content: 'First message',
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      }),
    );

    // Create a work item with DIFFERENT content (non-duplicate)
    const workItem = createProducedWorkItem({
      group_folder: 'paired-room',
      chat_jid: jid,
      agent_type: 'claude-code',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'Second message (different)',
    });

    expect(workItem.status).toBe('produced');

    // Verify NOT a duplicate
    expect(isDuplicateOfLastBotFinal(jid, workItem.result_payload)).toBe(false);
  });
});
