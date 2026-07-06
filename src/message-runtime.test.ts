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

describe('createMessageRuntime paired-room bot message filtering', () => {
  it('ignores generic failure bot messages in paired rooms', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
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

    vi.mocked(config.isClaudeService).mockReturnValue(false);
    vi.mocked(config.isReviewService).mockReturnValue(false);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
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
      runId: 'run-mentionless-paired-bot-message',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      '그 방향이 맞습니다.',
    );
    expect(channel.setTyping).toHaveBeenCalledWith(chatJid, true);
    expect(channel.setTyping).toHaveBeenCalledWith(chatJid, false);
    expect(lastAgentTimestamps[chatJid]).toBe('1');
    expect(saveState).toHaveBeenCalled();
  });

  it('does not defer typing-on for review turns', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(config.isClaudeService).mockReturnValue(false);
    vi.mocked(config.isReviewService).mockReturnValue(true);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'other-bot@test',
        sender_name: 'Other Bot',
        content: '이어서 확인해줘.',
        timestamp: '2026-03-18T09:00:00.000Z',
        is_bot_message: true,
      },
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementationOnce(
      async (_group, _input, _onProcess, onOutput) => {
        expect(channel.setTyping).toHaveBeenCalledWith(chatJid, true);
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '리뷰 확인 완료입니다.',
          newSessionId: 'session-review-follow-up-immediate',
        });
        return {
          status: 'success',
          result: '리뷰 확인 완료입니다.',
          newSessionId: 'session-review-follow-up-immediate',
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
      runId: 'run-review-follow-up-immediate-typing',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(channel.setTyping).toHaveBeenCalledWith(chatJid, true);
    expect(channel.setTyping).toHaveBeenCalledWith(chatJid, false);
  });

  it('ignores watcher status control messages in paired rooms', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
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
      runId: 'run-ignore-watch-status',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(channel.setTyping).not.toHaveBeenCalled();
    expect(lastAgentTimestamps[chatJid]).toBe('0');
    expect(saveState).toHaveBeenCalled();
  });
});
