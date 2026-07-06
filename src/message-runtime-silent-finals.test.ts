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

describe('createMessageRuntime silent run completion', () => {
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

  it('does not emit a visible message when the final output is structured silent output', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
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
      output: { visibility: 'silent' },
      newSessionId: 'session-structured-silent-run',
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
      runId: 'run-structured-silent-only',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(channel.sendAndTrack).not.toHaveBeenCalled();
    expect(channel.setTyping).toHaveBeenCalledWith(chatJid, true);
    expect(channel.setTyping).toHaveBeenCalledWith(chatJid, false);
  });

  it('promotes the last visible progress to a final message when the final output is structured silent', async () => {
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

    vi.mocked(channel.sendAndTrack!).mockResolvedValueOnce('progress-1');

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '첫 번째 진행상황입니다.',
          newSessionId: 'session-progress-structured-silent',
        });
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '두 번째 진행상황입니다.',
          newSessionId: 'session-progress-structured-silent',
        });
        await vi.runOnlyPendingTimersAsync();
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: null,
          output: { visibility: 'silent' },
          newSessionId: 'session-progress-structured-silent',
        });

        return {
          status: 'success',
          result: null,
          output: { visibility: 'silent' },
          newSessionId: 'session-progress-structured-silent',
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
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-progress-structured-silent',
        reason: 'messages',
      });

      expect(result).toBe(true);
      expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
      expect(channel.sendMessage).not.toHaveBeenCalled();
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        '첫 번째 진행상황입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createMessageRuntime typing and empty-final resets', () => {
  it('starts typing immediately for turns with visible output', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
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

    vi.mocked(agentRunner.runAgentProcess).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'visible reply',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-visible-reply',
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
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-visible-reply',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(channel.sendMessage).toHaveBeenCalledWith(chatJid, 'visible reply');
    expect(channel.setTyping).toHaveBeenCalledWith(chatJid, true);
    expect(channel.setTyping).toHaveBeenCalledWith(chatJid, false);
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
      // finish() replaces the latest tracked progress message with the final text
      expect(channel.sendMessage).not.toHaveBeenCalled();
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-2',
        '두 번째 진행상황입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createMessageRuntime flushed progress promotion', () => {
  it('promotes the last flushed progress output to a final message when the agent completes without a final phase', async () => {
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
        runId: 'run-progress-only',
        reason: 'messages',
      });

      expect(result).toBe(true);
      // First progress flushed when second arrives
      expect(channel.sendAndTrack).toHaveBeenCalledWith(
        chatJid,
        P('검증 중입니다.\n\n0초'),
      );
      // Once the tracked progress exists, later progress updates replace the visible heading directly.
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        P('테스트도 통과했습니다.\n\n5초'),
      );
      // finish() replaces the tracked progress message with the replayed final text
      expect(channel.sendMessage).not.toHaveBeenCalled();
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        '검증 중입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps going after a tracked progress edit fails and still emits the last flushed final message', async () => {
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
        runId: 'run-progress-recreate',
        reason: 'messages',
      });

      expect(result).toBe(true);
      // The first flushed progress is still tracked
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
      // finish() replaces the tracked progress message with the replayed final text
      expect(channel.sendMessage).not.toHaveBeenCalled();
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        '진행 중입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createMessageRuntime silent failures and single-final guarantees', () => {
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
      getRoomBindings: () => ({ [chatJid]: group }),
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
      runId: 'run-progress-error',
      reason: 'messages',
    });

    expect(result).toBe(true);
    // First progress flushed when second arrives
    expect(channel.sendAndTrack).toHaveBeenCalledWith(
      chatJid,
      P('중간 진행상황입니다.\n\n0초'),
    );
    // Error replaces the tracked progress message with the failure final
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(channel.editMessage).toHaveBeenCalledWith(
      chatJid,
      'progress-1',
      '요청을 완료하지 못했습니다. 다시 시도해 주세요.',
    );
    expect(lastAgentTimestamps[chatJid]).toBe('1');
    expect(saveState).toHaveBeenCalled();
  });
});

describe('createMessageRuntime missing streamed phase finals', () => {
  it('treats missing streamed phase as final output', async () => {
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

    vi.mocked(agentRunner.runAgentProcess).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'phase 없는 최종 응답입니다.',
        });
        return {
          status: 'success',
          result: null,
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
      runId: 'run-missing-phase-final',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'phase 없는 최종 응답입니다.',
    );
  });
});
