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
import type { Channel } from './types.js';
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

describe('createMessageRuntime fresh human input routing', () => {
  it('routes fresh human input to owner even when the latest task is review_ready', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel = makeChannel(chatJid);
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-human-owner-override',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    } as any);
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'human-override-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '새로 다시 진행해줘',
        timestamp: '2026-03-30T00:00:01.000Z',
        seq: 1,
        is_bot_message: false,
      } as any,
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'DONE_WITH_CONCERNS\nowner handled fresh input',
          newSessionId: 'session-human-owner-override',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\nowner handled fresh input',
          newSessionId: 'session-human-owner-override',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [ownerChannel, reviewerChannel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
        enqueueMessageCheck: vi.fn(),
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
      runId: 'run-human-owner-override',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(ownerChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'DONE_WITH_CONCERNS\nowner handled fresh input',
    );
    expect(reviewerChannel.sendMessage).not.toHaveBeenCalled();
  });

  it('routes fresh human input to owner even when the latest task is in_review', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel = makeChannel(chatJid);
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-human-owner-override-in-review',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'in_review',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    } as any);
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'human-override-in-review-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '방금 말한 조건도 같이 반영해줘',
        timestamp: '2026-03-30T00:00:01.000Z',
        seq: 1,
        is_bot_message: false,
      } as any,
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'DONE_WITH_CONCERNS\nowner handled fresh in_review input',
          newSessionId: 'session-human-owner-override-in-review',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\nowner handled fresh in_review input',
          newSessionId: 'session-human-owner-override-in-review',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [ownerChannel, reviewerChannel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
        enqueueMessageCheck: vi.fn(),
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
      runId: 'run-human-owner-override-in-review',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(ownerChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'DONE_WITH_CONCERNS\nowner handled fresh in_review input',
    );
    expect(reviewerChannel.sendMessage).not.toHaveBeenCalled();
  });
});

describe('createMessageRuntime fail-closed on missing role channels', () => {
  it('fails closed for in-review turns without fresh human input when the reviewer channel is missing', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel = makeChannel(chatJid);
    const lastAgentTimestamps: Record<string, string> = {};
    const saveState = vi.fn();

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-review-pending-missing-channel',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 0,
      status: 'in_review',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    });
    vi.mocked(db.getMessagesSince).mockReturnValue([] as any);

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [ownerChannel],
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
      runId: 'run-pending-review-missing-channel',
      reason: 'messages',
    });

    expect(result).toBe(false);
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
    expect(lastAgentTimestamps[`${chatJid}:reviewer`]).toBeUndefined();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('fails closed for pending arbiter turns when the arbiter channel is missing', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel = makeChannel(chatJid);
    const lastAgentTimestamps: Record<string, string> = {};
    const saveState = vi.fn();

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-arbiter-pending-missing-channel',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 3,
      status: 'arbiter_requested',
      arbiter_verdict: null,
      arbiter_requested_at: '2026-03-30T00:00:10.000Z',
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:10.000Z',
    });
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'human-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '판정해줘',
        timestamp: '2026-03-30T00:00:11.000Z',
        seq: 22,
        is_bot_message: false,
      },
    ] as any);

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [ownerChannel],
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
      runId: 'run-pending-arbiter-missing-channel',
      reason: 'messages',
    });

    expect(result).toBe(false);
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
    expect(lastAgentTimestamps[`${chatJid}:arbiter`]).toBeUndefined();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('fails closed for normal arbiter turns when the arbiter channel is missing', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel = makeChannel(chatJid);

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-arbiter-normal-missing-channel',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 3,
      status: 'in_arbitration',
      arbiter_verdict: null,
      arbiter_requested_at: '2026-03-30T00:00:10.000Z',
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:10.000Z',
    });
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'human-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '판정해줘',
        timestamp: '2026-03-30T00:00:11.000Z',
        is_bot_message: false,
      },
    ] as any);

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [ownerChannel],
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
      runId: 'run-normal-arbiter-missing-channel',
      reason: 'messages',
    });

    expect(result).toBe(false);
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
  });
});

describe('createMessageRuntime fixed-role bot history labeling', () => {
  it('labels raw reviewer bot history by fixed role in paired turn prompts', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};
    const ownerChannel = makeChannel(chatJid);
    const reviewerChannel: Channel = {
      ...makeChannel(chatJid, 'discord-review', false),
      isOwnMessage: vi.fn((msg) => msg.sender === 'shared-bot@test'),
    };

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: chatJid,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: null,
      owner_service_id: 'claude',
      reviewer_service_id: 'claude',
      arbiter_service_id: null,
      owner_failover_active: false,
      activated_at: null,
      reason: null,
      explicit: false,
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-same-service',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'in_review',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    });
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([]);
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'human-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '계속 진행해줘',
        timestamp: '2026-03-30T00:00:01.000Z',
        is_bot_message: false,
      },
      {
        id: 'bot-1',
        chat_jid: chatJid,
        sender: 'shared-bot@test',
        sender_name: 'Shared Bot',
        content: 'reviewer-like reply',
        timestamp: '2026-03-30T00:00:02.000Z',
        is_bot_message: true,
      },
    ] as any);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        expect(input.prompt).toContain(
          '<message sender="reviewer" time="30 Mar 09:00">reviewer-like reply</message>',
        );
        expect(input.prompt).not.toContain(
          '<message sender="owner" time="30 Mar 09:00">reviewer-like reply</message>',
        );
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '같은 서비스 턴 확인',
          newSessionId: 'session-same-service-fallback',
        });
        return {
          status: 'success',
          result: '같은 서비스 턴 확인',
          newSessionId: 'session-same-service-fallback',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'Asia/Seoul',
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
      runId: 'run-fixed-reviewer-bot-history',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
  });

  it('labels raw arbiter bot history by fixed role in arbiter prompts', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const ownerChannel = makeChannel(chatJid);
    const arbiterChannel: Channel = {
      ...makeChannel(chatJid, 'discord-arbiter', false),
      isOwnMessage: vi.fn((msg) => msg.sender === 'shared-bot@test'),
    };

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(serviceRouting.getEffectiveChannelLease).mockReturnValue({
      chat_jid: chatJid,
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: 'claude-code',
      owner_service_id: 'claude',
      reviewer_service_id: 'claude',
      arbiter_service_id: 'claude-arbiter',
      owner_failover_active: false,
      activated_at: null,
      reason: null,
      explicit: false,
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-same-service-arbiter',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 2,
      status: 'arbiter_requested',
      arbiter_verdict: null,
      arbiter_requested_at: '2026-03-30T00:00:10.000Z',
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:10.000Z',
    });
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([]);
    vi.mocked(db.getRecentChatMessages).mockReturnValue([
      {
        id: 'human-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '둘 중 누가 맞는지 판단해줘',
        timestamp: '2026-03-30T00:00:01.000Z',
        is_bot_message: false,
      },
      {
        id: 'bot-1',
        chat_jid: chatJid,
        sender: 'shared-bot@test',
        sender_name: 'Shared Bot',
        content: 'reviewer-like reply',
        timestamp: '2026-03-30T00:00:02.000Z',
        is_bot_message: true,
      },
    ] as any);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        expect(input.prompt).toContain(
          '<message sender="arbiter" time="30 Mar 09:00">reviewer-like reply</message>',
        );
        expect(input.prompt).not.toContain(
          '<message sender="owner" time="30 Mar 09:00">reviewer-like reply</message>',
        );
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '중재 문맥 확인',
          newSessionId: 'session-same-service-arbiter',
        });
        return {
          status: 'success',
          result: '중재 문맥 확인',
          newSessionId: 'session-same-service-arbiter',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'Asia/Seoul',
      triggerPattern: /^@Andy\b/i,
      channels: [ownerChannel, arbiterChannel],
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
      runId: 'run-fixed-arbiter-bot-history',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
  });
});
