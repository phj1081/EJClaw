import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TASK_STATUS_MESSAGE_PREFIX } from './task-watch-status.js';

/** Prefix helper for progress message assertions */
const P = (text: string) => `${TASK_STATUS_MESSAGE_PREFIX}${text}`;

vi.mock('./agent-runner.js', () => ({
  runAgentProcess: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/ejclaw-test-data',
  isSessionCommandSenderAllowed: vi.fn(() => false),
}));

vi.mock('./db.js', () => {
  const getMessagesSince = vi.fn(
    (
      _chatJid?: string,
      _sinceCursor?: string,
      _botPrefix?: string,
      _limit?: number,
    ) => [],
  );
  const getNewMessages = vi.fn(
    (
      _jids?: string[],
      _lastSeqCursor?: string,
      _botPrefix?: string,
      _limit?: number,
    ) => ({ messages: [], newSeqCursor: '0' }),
  );
  const withSeqs = (messages: Array<Record<string, unknown>>) =>
    messages.map((message, index) => ({
      ...message,
      seq: typeof message.seq === 'number' ? message.seq : index + 1,
    }));

  return {
    getAllChats: vi.fn(() => []),
    getAllTasks: vi.fn(() => []),
    getLastHumanMessageTimestamp: vi.fn(() => null),
    getMessagesSince,
    getNewMessages,
    getLatestMessageSeqAtOrBefore: vi.fn(() => 0),
    getMessagesSinceSeq: vi.fn(
      (
        chatJid: string,
        sinceSeqCursor: string,
        botPrefix: string,
        limit?: number,
      ) =>
        withSeqs(getMessagesSince(chatJid, sinceSeqCursor, botPrefix, limit)),
    ),
    getNewMessagesBySeq: vi.fn(
      (
        jids: string[],
        lastSeqCursor: string,
        botPrefix: string,
        limit?: number,
      ) => {
        const result:
          | {
              messages?: Array<Record<string, unknown>>;
              newSeqCursor?: string;
              newTimestamp?: string;
            }
          | undefined = getNewMessages(
          jids,
          lastSeqCursor,
          botPrefix,
          limit,
        ) || {
          messages: [],
          newSeqCursor: '0',
        };
        const messages = withSeqs(result.messages || []);
        const lastSeq =
          messages.length > 0
            ? String(messages[messages.length - 1].seq)
            : String(lastSeqCursor || '0');
        return {
          messages,
          newSeqCursor: result.newSeqCursor || result.newTimestamp || lastSeq,
        };
      },
    ),
    getOpenWorkItem: vi.fn(() => undefined),
    createProducedWorkItem: vi.fn((input) => ({
      id: 1,
      group_folder: input.group_folder,
      chat_jid: input.chat_jid,
      agent_type: input.agent_type || 'claude-code',
      status: 'produced',
      start_seq: input.start_seq,
      end_seq: input.end_seq,
      result_payload: input.result_payload,
      delivery_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
      delivery_message_id: null,
      last_error: null,
    })),
    markWorkItemDelivered: vi.fn(),
    markWorkItemDeliveryRetry: vi.fn(),
    isPairedRoomJid: vi.fn(() => false),
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./provider-fallback.js', () => ({
  detectFallbackTrigger: vi.fn(() => ({ shouldFallback: false, reason: '' })),
  getActiveProvider: vi.fn(async () => 'claude'),
  getFallbackEnvOverrides: vi.fn(() => ({
    ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
    ANTHROPIC_AUTH_TOKEN: 'test-kimi-key',
    ANTHROPIC_MODEL: 'kimi-k2.5',
  })),
  getFallbackProviderName: vi.fn(() => 'kimi'),
  hasGroupProviderOverride: vi.fn(() => false),
  isFallbackEnabled: vi.fn(() => true),
  markPrimaryCooldown: vi.fn(),
}));

vi.mock('./sender-allowlist.js', () => ({
  isTriggerAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({})),
}));

vi.mock('./session-commands.js', () => ({
  extractSessionCommand: vi.fn(() => null),
  handleSessionCommand: vi.fn(async () => ({ handled: false })),
  isSessionCommandAllowed: vi.fn(() => true),
  isSessionCommandControlMessage: vi.fn(() => false),
}));

import * as agentRunner from './agent-runner.js';
import * as db from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { createMessageRuntime } from './message-runtime.js';
import * as providerFallback from './provider-fallback.js';
import type { Channel, RegisteredGroup } from './types.js';

function makeGroup(agentType: 'claude-code' | 'codex'): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: `test-${agentType}`,
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    agentType,
  };
}

function makeChannel(chatJid: string): Channel {
  return {
    name: 'discord',
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAndTrack: vi.fn().mockResolvedValue('progress-1'),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => jid === chatJid),
    disconnect: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createMessageRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(providerFallback.getActiveProvider).mockResolvedValue('claude');
    vi.mocked(providerFallback.getFallbackProviderName).mockReturnValue('kimi');
    vi.mocked(providerFallback.getFallbackEnvOverrides).mockReturnValue({
      ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
      ANTHROPIC_AUTH_TOKEN: 'test-kimi-key',
      ANTHROPIC_MODEL: 'kimi-k2.5',
    });
    vi.mocked(providerFallback.hasGroupProviderOverride).mockReturnValue(false);
    vi.mocked(providerFallback.isFallbackEnabled).mockReturnValue(true);
    vi.mocked(providerFallback.detectFallbackTrigger).mockReturnValue({
      shouldFallback: false,
      reason: '',
    });
  });

  it('ignores generic failure bot messages in paired rooms', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(db.isPairedRoomJid).mockReturnValue(true);
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'other-bot@test',
        sender_name: 'Other Bot',
        content: '요청을 완료하지 못했습니다. 다시 시도해 주세요.',
        timestamp: '2026-03-18T09:00:00.000Z',
        is_bot_message: true,
      },
    ]);

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-ignore-bot-failure-loop',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(lastAgentTimestamps[chatJid]).toBe('0');
    expect(saveState).toHaveBeenCalled();
  });

  it('keeps mentionless substantive bot messages in paired rooms', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(db.isPairedRoomJid).mockReturnValue(true);
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'other-bot@test',
        sender_name: 'Other Bot',
        content: '정리해보면 Reaction Engine이 1순위 같아.',
        timestamp: '2026-03-18T09:00:00.000Z',
        is_bot_message: true,
      },
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: '그 방향이 맞습니다.',
          newSessionId: 'session-paired-bot',
        });
        return {
          status: 'success',
          result: '그 방향이 맞습니다.',
          newSessionId: 'session-paired-bot',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-mentionless-paired-bot-message',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      '그 방향이 맞습니다.',
    );
    expect(lastAgentTimestamps[chatJid]).toBe('1');
    expect(saveState).toHaveBeenCalled();
  });

  it('ignores watcher status control messages in paired rooms', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(db.isPairedRoomJid).mockReturnValue(true);
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'codex-bot@test',
        sender_name: 'Codex',
        content: '\u2063\u2063\u2063CI 감시 중: run 123',
        timestamp: '2026-03-23T00:00:00.000Z',
        is_bot_message: true,
      },
    ]);

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-ignore-watch-status',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(channel.setTyping).not.toHaveBeenCalled();
    expect(lastAgentTimestamps[chatJid]).toBe('0');
    expect(saveState).toHaveBeenCalled();
  });

  it('allows follow-up messages without a trigger after a visible reply in non-main groups', async () => {
    const chatJid = 'group@test';
    const group: RegisteredGroup = {
      ...makeGroup('codex'),
      requiresTrigger: true,
    };
    const channel = makeChannel(chatJid);
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(db.getMessagesSince)
      .mockReturnValueOnce([
        {
          id: 'msg-1',
          chat_jid: chatJid,
          sender: 'user@test',
          sender_name: 'User',
          content: '@Andy 첫 요청',
          timestamp: '2026-03-18T09:00:00.000Z',
        },
      ])
      .mockReturnValueOnce([
        {
          id: 'msg-2',
          chat_jid: chatJid,
          sender: 'user@test',
          sender_name: 'User',
          content: '두 번째 말은 멘션 없이 이어서',
          timestamp: '2026-03-18T09:00:10.000Z',
        },
      ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: '응답했습니다.',
          phase: 'final',
        });
        return {
          status: 'success',
          result: '응답했습니다.',
          phase: 'final',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 60_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const first = await runtime.processGroupMessages(chatJid, {
      runId: 'run-triggered-first-turn',
      reason: 'messages',
    });
    const second = await runtime.processGroupMessages(chatJid, {
      runId: 'run-triggerless-follow-up',
      reason: 'messages',
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(channel.sendMessage).toHaveBeenNthCalledWith(
      1,
      chatJid,
      '응답했습니다.',
    );
    expect(channel.sendMessage).toHaveBeenNthCalledWith(
      2,
      chatJid,
      '응답했습니다.',
    );
  });

  it('clears Claude sessions and closes stdin immediately on poisoned output', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const channel = makeChannel(chatJid);
    const closeStdin = vi.fn();
    const notifyIdle = vi.fn();
    const persistSession = vi.fn();
    const clearSession = vi.fn();
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-18T09:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result:
            'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
          newSessionId: 'session-123',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-123',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin,
        notifyIdle,
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession,
      clearSession,
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-1',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(persistSession).toHaveBeenCalledWith(group.folder, 'session-123');
    expect(clearSession).toHaveBeenCalledWith(group.folder);
    expect(closeStdin).toHaveBeenCalledWith(chatJid, {
      runId: 'run-1',
      reason: 'poisoned-session-detected',
    });
    expect(notifyIdle).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
    );
    expect(lastAgentTimestamps[chatJid]).toBe('1');
    expect(saveState).toHaveBeenCalled();
  });

  it('does not apply the poisoned-session handling to Codex groups', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const closeStdin = vi.fn();
    const notifyIdle = vi.fn();
    const clearSession = vi.fn();

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-18T09:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result:
            'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
          newSessionId: 'session-456',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-456',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin,
        notifyIdle,
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession,
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-2',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(clearSession).not.toHaveBeenCalled();
    expect(notifyIdle).not.toHaveBeenCalled();
    expect(closeStdin).toHaveBeenCalledWith(chatJid, {
      runId: 'run-2',
      reason: 'output-delivered-close',
    });
  });

  it('tracks Codex progress in one editable message and promotes the last progress when the run ends without a final phase', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const notifyIdle = vi.fn();
    const persistSession = vi.fn();

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        // First progress: buffered only (not sent to Discord yet)
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: 'CI 상태 확인 중입니다.',
          newSessionId: 'session-progress',
        });
        expect(notifyIdle).not.toHaveBeenCalled();
        // Second progress: flushes the first one to Discord (creates tracked message)
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '테스트 실행 중입니다.',
          newSessionId: 'session-progress',
        });
        // Timer advance triggers progress ticker → edits the tracked message
        await vi.advanceTimersByTimeAsync(10_000);
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'session-progress',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-progress',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle,
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession,
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-progress',
        reason: 'messages',
      });

      expect(result).toBe(true);
      // First progress flushed when the second progress arrives
      expect(channel.sendAndTrack).toHaveBeenCalledWith(
        chatJid,
        P('CI 상태 확인 중입니다.\n\n0초'),
      );
      // Timer tick edits the tracked progress with updated elapsed time
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        P('CI 상태 확인 중입니다.\n\n10초'),
      );
      // finish() promotes the last flushed progress text to a final message
      expect(channel.sendMessage).toHaveBeenCalledTimes(1);
      expect(channel.sendMessage).toHaveBeenCalledWith(
        chatJid,
        'CI 상태 확인 중입니다.',
      );
      expect(notifyIdle).not.toHaveBeenCalled();
      expect(persistSession).toHaveBeenCalledWith(
        group.folder,
        'session-progress',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a plain progress message when tracked progress creation throws', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(channel.sendAndTrack!).mockRejectedValueOnce(
      new Error('discord send failed'),
    );

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        // First progress: buffered
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '진행 중입니다.',
          newSessionId: 'session-progress-fallback',
        });
        // Second progress: flushes first (sendAndTrack throws -> falls back to sendMessage)
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '계속 진행 중입니다.',
          newSessionId: 'session-progress-fallback',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-progress-fallback',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-progress-fallback-throw',
      reason: 'messages',
    });

    expect(result).toBe(true);
    // First progress flushed when second arrives — sendAndTrack throws, falls back to sendMessage
    expect(channel.sendAndTrack).toHaveBeenCalledWith(
      chatJid,
      P('진행 중입니다.\n\n0초'),
    );
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      P('진행 중입니다.\n\n0초'),
    );
  });

  it('falls back to a plain progress message when tracked progress creation returns null', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(channel.sendAndTrack!).mockResolvedValueOnce(null as any);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        // First progress: buffered
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '진행 중입니다.',
          newSessionId: 'session-progress-null-fallback',
        });
        // Second progress: flushes first (sendAndTrack returns null -> falls back to sendMessage)
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '계속 진행 중입니다.',
          newSessionId: 'session-progress-null-fallback',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-progress-null-fallback',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-progress-fallback-null',
      reason: 'messages',
    });

    expect(result).toBe(true);
    // First progress flushed when second arrives — sendAndTrack returns null, falls back to sendMessage
    expect(channel.sendAndTrack).toHaveBeenCalledWith(
      chatJid,
      P('진행 중입니다.\n\n0초'),
    );
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      P('진행 중입니다.\n\n0초'),
    );
  });

  it('discards late progress and duplicate final after a terminal final', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const closeStdin = vi.fn();

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        // First progress: buffered only
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '첫 번째 진행상황입니다.',
          newSessionId: 'session-terminal',
        });
        // Second progress: flushes the first to Discord
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '두 번째 진행상황입니다.',
          newSessionId: 'session-terminal',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '최종 답변입니다.',
          newSessionId: 'session-terminal',
        });
        // Late output after terminal final — should be discarded
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '늦게 도착한 진행상황입니다.',
          newSessionId: 'session-terminal',
        });
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '중복 최종 답변입니다.',
          newSessionId: 'session-terminal',
        });

        return {
          status: 'success',
          result: null,
          newSessionId: 'session-terminal',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 20_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin,
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-terminal-final',
        reason: 'messages',
      });

      expect(result).toBe(true);
      expect(closeStdin).toHaveBeenCalledWith(chatJid, {
        runId: 'run-terminal-final',
        reason: 'output-delivered-close',
      });
      // First progress flushed when the second arrives
      expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
      expect(channel.sendAndTrack).toHaveBeenCalledWith(
        chatJid,
        P('첫 번째 진행상황입니다.\n\n0초'),
      );
      // Timer tick updates tracked progress via edit
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        P('첫 번째 진행상황입니다.\n\n10초'),
      );
      // Late progress and duplicate final are discarded
      expect(channel.editMessage).not.toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        expect.stringContaining('늦게 도착한 진행상황입니다.'),
      );
      expect(channel.sendMessage).toHaveBeenCalledTimes(1);
      expect(channel.sendMessage).toHaveBeenCalledWith(
        chatJid,
        '최종 답변입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('formats longer Codex progress durations with minutes and hours', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        // First progress: buffered only
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '오래 걸리는 작업입니다.',
          newSessionId: 'session-long-progress',
        });
        // Second progress: flushes first to Discord, starts timer tracking
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '아직 진행 중입니다.',
          newSessionId: 'session-long-progress',
        });
        await vi.advanceTimersByTimeAsync(70_000);
        await vi.advanceTimersByTimeAsync(50_000);
        await vi.advanceTimersByTimeAsync(3_480_000);
        await vi.advanceTimersByTimeAsync(70_000);
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'session-long-progress',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-long-progress',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-long-progress',
        reason: 'messages',
      });

      expect(result).toBe(true);
      // First progress flushed when second arrives
      expect(channel.sendAndTrack).toHaveBeenCalledWith(
        chatJid,
        P('오래 걸리는 작업입니다.\n\n0초'),
      );
      // Timer ticks update the tracked progress with longer durations
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        P('오래 걸리는 작업입니다.\n\n1시간 0초'),
      );
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        P('오래 걸리는 작업입니다.\n\n1시간 10초'),
      );
      // finish() promotes the last flushed progress text to a final message
      expect(channel.sendMessage).toHaveBeenCalledWith(
        chatJid,
        '오래 걸리는 작업입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps progress separate from the final Codex answer', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const notifyIdle = vi.fn();

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        // First progress: buffered only
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '테스트를 돌리는 중입니다.',
          newSessionId: 'session-final',
        });
        // Second progress: flushes first to Discord
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '빌드 중입니다.',
          newSessionId: 'session-final',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '테스트가 끝났습니다.',
          newSessionId: 'session-final',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-final',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle,
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-final',
        reason: 'messages',
      });

      expect(result).toBe(true);
      // First progress flushed when second arrives
      expect(channel.sendAndTrack).toHaveBeenCalledWith(
        chatJid,
        P('테스트를 돌리는 중입니다.\n\n0초'),
      );
      // Timer tick updates tracked progress
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        P('테스트를 돌리는 중입니다.\n\n10초'),
      );
      // Final delivered as separate message
      expect(channel.sendMessage).toHaveBeenCalledTimes(1);
      expect(channel.sendMessage).toHaveBeenCalledWith(
        chatJid,
        '테스트가 끝났습니다.',
      );
      expect(notifyIdle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry or emit a synthetic final when a run completes silently', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const lastAgentTimestamps: Record<string, string> = {};
    const saveState = vi.fn();

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
        seq: 1,
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockResolvedValue({
      status: 'success',
      result: null,
      newSessionId: 'session-silent-run',
    });

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-silent-rollover',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalled();
    expect(lastAgentTimestamps[chatJid]).toBe('1');
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(channel.sendAndTrack).not.toHaveBeenCalled();
  });

  it('resets tracked progress after a final output that becomes empty after formatting', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(channel.sendAndTrack!)
      .mockResolvedValueOnce('progress-1')
      .mockResolvedValueOnce('progress-2');

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        // First progress: buffered
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '첫 번째 진행상황입니다.',
          newSessionId: 'session-empty-final',
        });
        // Second progress: flushes first to Discord
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '계속 진행 중입니다.',
          newSessionId: 'session-empty-final',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        // Empty final: resets tracked progress state (pending cleared by finalizeProgressMessage)
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '<internal>hidden final</internal>',
          newSessionId: 'session-empty-final',
        });
        // Third progress after reset: buffered
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '두 번째 진행상황입니다.',
          newSessionId: 'session-empty-final',
        });
        // Fourth progress: flushes third to Discord (new progress-2 message)
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '거의 완료입니다.',
          newSessionId: 'session-empty-final',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'session-empty-final',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-empty-final',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-empty-final',
        reason: 'messages',
      });

      expect(result).toBe(true);
      // First progress flushed when second arrives
      expect(channel.sendAndTrack).toHaveBeenNthCalledWith(
        1,
        chatJid,
        P('첫 번째 진행상황입니다.\n\n0초'),
      );
      // After empty final resets state, third progress flushed when fourth arrives (new message)
      expect(channel.sendAndTrack).toHaveBeenNthCalledWith(
        2,
        chatJid,
        P('두 번째 진행상황입니다.\n\n0초'),
      );
      // Timer tick edits the first tracked progress
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        P('첫 번째 진행상황입니다.\n\n10초'),
      );
      // Timer tick edits the second tracked progress
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-2',
        P('두 번째 진행상황입니다.\n\n10초'),
      );
      // finish() promotes the last flushed progress text to a final message
      expect(channel.sendMessage).toHaveBeenCalledTimes(1);
      expect(channel.sendMessage).toHaveBeenCalledWith(
        chatJid,
        '두 번째 진행상황입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('promotes the last progress output to a final message when the agent completes without a final phase', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(channel.sendAndTrack!).mockResolvedValueOnce('progress-1');

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        // First progress: buffered
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '검증 중입니다.',
          newSessionId: 'session-progress-only',
        });
        // Second progress: flushes first to Discord (creates tracked message)
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '커밋은 정상 들어갔고 pre-commit도 통과했습니다.',
          newSessionId: 'session-progress-only',
        });
        // Third progress: updates tracked message heading directly
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '테스트도 통과했습니다.',
          newSessionId: 'session-progress-only',
        });
        // Advance timer so the ticker fires and syncs the tracked message
        await vi.advanceTimersByTimeAsync(5_000);
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'session-progress-only',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-progress-only',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-progress-only',
        reason: 'messages',
      });

      expect(result).toBe(true);
      // First progress flushed when second arrives
      expect(channel.sendAndTrack).toHaveBeenCalledWith(
        chatJid,
        P('검증 중입니다.\n\n0초'),
      );
      // Ticker fires after advanceTimersByTime — edits tracked message with latest heading
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        P('테스트도 통과했습니다.\n\n5초'),
      );
      // finish() promotes the last flushed progress text to a final message
      expect(channel.sendMessage).toHaveBeenCalledTimes(1);
      expect(channel.sendMessage).toHaveBeenCalledWith(
        chatJid,
        '검증 중입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries editing progress message instead of creating a duplicate when edit fails', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(channel.sendAndTrack!).mockResolvedValueOnce('progress-1');
    vi.mocked(channel.editMessage!)
      .mockRejectedValueOnce(new Error('discord edit failed'))
      .mockResolvedValue(undefined as any);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        // First progress: buffered
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '진행 중입니다.',
          newSessionId: 'session-progress-recreate',
        });
        // Second progress: flushes first (creates tracked message via sendAndTrack)
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '아직 진행 중.',
          newSessionId: 'session-progress-recreate',
        });
        // Third progress: updates heading directly (edit fails once on ticker, then succeeds on retry)
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '거의 완료.',
          newSessionId: 'session-progress-recreate',
        });
        // Advance timer so the ticker fires and syncs (first edit fails, second succeeds)
        await vi.advanceTimersByTimeAsync(5_000);
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'session-progress-recreate',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-progress-recreate',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-progress-recreate',
        reason: 'messages',
      });

      expect(result).toBe(true);
      // Only one progress message created via sendAndTrack — no duplicate
      expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
      expect(channel.sendAndTrack).toHaveBeenCalledWith(
        chatJid,
        P('진행 중입니다.\n\n0초'),
      );
      // Edit is attempted on the tracked message (first fails, subsequent succeed)
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        expect.any(String),
      );
      // finish() promotes the last flushed progress text to a final message
      expect(channel.sendMessage).toHaveBeenCalledTimes(1);
      expect(channel.sendMessage).toHaveBeenCalledWith(
        chatJid,
        '진행 중입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not emit a visible failure final when a run stays silent', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const lastAgentTimestamps: Record<string, string> = {};
    const saveState = vi.fn();

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
        seq: 1,
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
      return {
        status: 'success',
        result: null,
        newSessionId: 'session-quiet-budget',
      };
    });

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 60_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-quiet-budget',
        reason: 'messages',
      });

      expect(result).toBe(true);
      expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
      expect(channel.sendMessage).not.toHaveBeenCalled();
      expect(lastAgentTimestamps[chatJid]).toBe('1');
      expect(saveState).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes stdin immediately after producing visible output (no idle lingering)', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const closeStdin = vi.fn();

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '진행 상황입니다.',
          newSessionId: 'session-close-after-output',
        });
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'session-close-after-output',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-close-after-output',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin,
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-close-after-output',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(closeStdin).toHaveBeenCalledWith(chatJid, {
      runId: 'run-close-after-output',
      reason: 'output-delivered-close',
    });
  });

  it('publishes exactly one final after a visible progress when the run errors', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        // First progress: buffered
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '중간 진행상황입니다.',
          newSessionId: 'session-error',
        });
        // Second progress: flushes first to Discord
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '계속 진행 중입니다.',
          newSessionId: 'session-error',
        });
        await onOutput?.({
          status: 'error',
          result: null,
          newSessionId: 'session-error',
          error: 'temporary failure',
        });
        return {
          status: 'error',
          result: null,
          newSessionId: 'session-error',
          error: 'temporary failure',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-progress-error',
      reason: 'messages',
    });

    expect(result).toBe(true);
    // First progress flushed when second arrives
    expect(channel.sendAndTrack).toHaveBeenCalledWith(
      chatJid,
      P('중간 진행상황입니다.\n\n0초'),
    );
    // Error causes failure final to be published
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      '요청을 완료하지 못했습니다. 다시 시도해 주세요.',
    );
    expect(lastAgentTimestamps[chatJid]).toBe('1');
    expect(saveState).toHaveBeenCalled();
  });

  it('retries with the fallback provider when Claude returns a 429 error before any output', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(providerFallback.detectFallbackTrigger).mockReturnValue({
      shouldFallback: true,
      reason: '429',
      retryAfterMs: 60_000,
    });

    vi.mocked(agentRunner.runAgentProcess)
      .mockResolvedValueOnce({
        status: 'error',
        result: null,
        error: '429 rate limited retry after 60',
      })
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'fallback 응답입니다.',
        });
        return {
          status: 'success',
          result: null,
        };
      });

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-fallback-429',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(agentRunner.runAgentProcess).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ sessionId: undefined }),
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({
        ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
        ANTHROPIC_MODEL: 'kimi-k2.5',
      }),
    );
    expect(providerFallback.markPrimaryCooldown).toHaveBeenCalledWith(
      '429',
      60_000,
    );
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'fallback 응답입니다.',
    );
  });

  it('retries with the fallback provider when Claude returns only a usage exhaustion banner', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-24T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: "You're out of extra usage · resets 4am (Asia/Seoul)",
        });
        return {
          status: 'success',
          result: null,
        };
      })
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'usage fallback 응답입니다.',
        });
        return {
          status: 'success',
          result: null,
        };
      });

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-fallback-usage-exhausted',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(providerFallback.markPrimaryCooldown).toHaveBeenCalledWith(
      'usage-exhausted',
      undefined,
    );
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'usage fallback 응답입니다.',
    );
  });

  it('suppresses duplicate streamed usage banners before retrying the fallback provider', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-24T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'intermediate',
          result: "You're out of extra usage · resets 4am (Asia/Seoul)",
        });
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: "You're out of extra usage · resets 4am (Asia/Seoul)",
        });
        return {
          status: 'success',
          result: null,
        };
      })
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'duplicate banner fallback 응답입니다.',
        });
        return {
          status: 'success',
          result: null,
        };
      });

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-fallback-usage-exhausted-duplicate',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(providerFallback.markPrimaryCooldown).toHaveBeenCalledWith(
      'usage-exhausted',
      undefined,
    );
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'duplicate banner fallback 응답입니다.',
    );
  });

  it('retries with the fallback provider when Claude ends with success-null-result before any output', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess)
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: null,
        });
        return {
          status: 'success',
          result: null,
        };
      })
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'success-null-result 폴백 응답입니다.',
        });
        return {
          status: 'success',
          result: null,
        };
      });

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-fallback-success-null',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(2);
    expect(providerFallback.markPrimaryCooldown).toHaveBeenCalledWith(
      'success-null-result',
      undefined,
    );
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'success-null-result 폴백 응답입니다.',
    );
  });

  it('recovery queues a group when an open work item is waiting for delivery', () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const enqueueMessageCheck = vi.fn();

    vi.mocked(db.getOpenWorkItem).mockReturnValue({
      id: 99,
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: 'claude-code',
      status: 'produced',
      start_seq: 1,
      end_seq: 1,
      result_payload: '미전달 결과',
      delivery_attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
      delivery_message_id: null,
      last_error: null,
    });

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [makeChannel(chatJid)],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
        enqueueMessageCheck,
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    runtime.recoverPendingMessages();

    expect(enqueueMessageCheck).toHaveBeenCalledWith(
      chatJid,
      resolveGroupIpcPath(group.folder),
    );
    expect(db.getMessagesSinceSeq).not.toHaveBeenCalled();
  });
});
