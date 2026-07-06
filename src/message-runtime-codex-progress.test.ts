import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-runner.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createAgentRunnerMock();
});

vi.mock('./config.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createConfigMock();
});

vi.mock('./paired-execution-context.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createPairedExecutionContextMock();
});

vi.mock('./db.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createDbMock();
});

vi.mock('./service-routing.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createServiceRoutingMock();
});

vi.mock('./logger.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createLoggerMock();
});

vi.mock('./sender-allowlist.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createSenderAllowlistMock();
});

vi.mock('./session-commands.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createSessionCommandsMock();
});

import * as agentRunner from './agent-runner.js';
import * as config from './config.js';
import * as db from './db.js';
import { createMessageRuntime } from './message-runtime.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';
import * as serviceRouting from './service-routing.js';
import {
  P,
  makeChannel,
  makeCodexLease,
  makeGroup,
} from '../test/helpers/message-runtime-fixtures.js';

beforeEach(() => {
  vi.resetAllMocks();
  resetPairedFollowUpScheduleState();
  vi.mocked(db.getLastBotFinalMessage).mockReturnValue([]);
  vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(false);
  vi.mocked(db.getRecentChatMessages).mockReturnValue([]);
  vi.mocked(config.isClaudeService).mockReturnValue(true);
  vi.mocked(config.isReviewService).mockReturnValue(false);
});

describe('createMessageRuntime tracked progress lifecycle', () => {
  it('tracks Codex progress in one editable message and promotes the last progress when the run ends without a final phase', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const notifyIdle = vi.fn();
    const persistSession = vi.fn();

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue(
      makeCodexLease(chatJid),
    );

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
      getRoomBindings: () => ({ [chatJid]: group }),
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
      // finish() replaces the tracked progress message with the final text
      expect(channel.sendMessage).not.toHaveBeenCalled();
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
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
      getRoomBindings: () => ({ [chatJid]: group }),
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
});

describe('createMessageRuntime tracked progress fallbacks and late output', () => {
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
      getRoomBindings: () => ({ [chatJid]: group }),
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
      getRoomBindings: () => ({ [chatJid]: group }),
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
      expect(channel.sendMessage).not.toHaveBeenCalled();
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        '최종 답변입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createMessageRuntime progress formatting and final promotion', () => {
  it('formats longer Codex progress durations with minutes and hours', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue(
      makeCodexLease(chatJid),
    );

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
        await vi.advanceTimersByTimeAsync(0);
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
      getRoomBindings: () => ({ [chatJid]: group }),
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
      // finish() replaces the tracked progress message with the final text
      expect(channel.sendMessage).not.toHaveBeenCalled();
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        '오래 걸리는 작업입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('promotes the tracked progress message into the final Codex answer', async () => {
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
      getRoomBindings: () => ({ [chatJid]: group }),
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
      // Final replaces the tracked progress message instead of creating a new one
      expect(channel.sendMessage).not.toHaveBeenCalled();
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        '테스트가 끝났습니다.',
      );
      expect(notifyIdle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
