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
import type { RegisteredGroup } from './types.js';
import {
  makeChannel,
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

describe('createMessageRuntime trigger-free group processing', () => {
  it('processes first and follow-up messages without trigger mentions in non-main groups', async () => {
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
          content: '첫 요청도 멘션 없이 보냄',
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
      getRoomBindings: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const first = await runtime.processGroupMessages(chatJid, {
      runId: 'run-triggerless-first-turn',
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
});

describe('createMessageRuntime poisoned session handling', () => {
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
      getRoomBindings: () => ({ [chatJid]: group }),
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

    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: chatJid,
      owner_agent_type: 'codex',
      reviewer_agent_type: null,
      arbiter_agent_type: null,
      owner_service_id: 'codex',
      reviewer_service_id: null,
      arbiter_service_id: null,
      owner_failover_active: false,
      activated_at: null,
      reason: null,
      explicit: false,
    });

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
      getRoomBindings: () => ({ [chatJid]: group }),
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
});
