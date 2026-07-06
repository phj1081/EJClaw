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
import { logger } from './logger.js';
import { createMessageRuntime } from './message-runtime.js';
import {
  resetPairedFollowUpScheduleState,
  schedulePairedFollowUpOnce,
} from './paired-follow-up-scheduler.js';
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

describe('createMessageRuntime reviewer re-enqueue after owner delivery', () => {
  it('re-enqueues reviewer after a successful owner delivery moves the task to review_ready', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel: Channel = {
      ...makeChannel(chatJid),
      isOwnMessage: vi.fn((msg) => msg.sender === 'owner-bot@test'),
    };
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const enqueueMessageCheck = vi.fn();
    const pairedTask = {
      id: 'task-owner-delivery-follow-up',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      round_trip_count: 0,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    } as any;

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockImplementation(
      () => pairedTask,
    );
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'human-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '이 구현 진행해줘',
        timestamp: '2026-03-30T00:00:00.000Z',
        seq: 1,
        is_bot_message: false,
      } as any,
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        pairedTask.status = 'review_ready';
        pairedTask.review_requested_at = '2026-03-30T00:00:01.000Z';
        pairedTask.round_trip_count = 1;
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'DONE_WITH_CONCERNS\nowner complete',
          newSessionId: 'session-owner-delivery-follow-up',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\nowner complete',
          newSessionId: 'session-owner-delivery-follow-up',
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
        enqueueMessageCheck,
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
      runId: 'run-owner-delivery-follow-up',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        runId: 'run-owner-delivery-follow-up',
        completedRole: 'owner',
        taskId: 'task-owner-delivery-follow-up',
        taskStatus: 'review_ready',
      }),
      'Queued paired follow-up after successful owner delivery',
    );
  });

  it('does not re-enqueue owner follow-up after a successful owner STEP_DONE delivery keeps the task active', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel: Channel = {
      ...makeChannel(chatJid),
      isOwnMessage: vi.fn((msg) => msg.sender === 'owner-bot@test'),
    };
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const enqueueMessageCheck = vi.fn();
    const pairedTask = {
      id: 'task-owner-step-done-follow-up',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      round_trip_count: 1,
      owner_failure_count: 2,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    } as any;
    let turnOutputs: any[] = [];

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockImplementation(
      () => pairedTask,
    );
    vi.mocked(db.getPairedTurnOutputs).mockImplementation((taskId: string) =>
      taskId === pairedTask.id ? turnOutputs : [],
    );
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'human-step-done-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '이 리팩토링 이어서 해줘',
        timestamp: '2026-03-30T00:00:00.000Z',
        seq: 1,
        is_bot_message: false,
      } as any,
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        pairedTask.status = 'active';
        pairedTask.owner_failure_count = 0;
        turnOutputs = [
          {
            id: 1,
            task_id: pairedTask.id,
            turn_number: 1,
            role: 'owner',
            output_text: 'STEP_DONE\n리팩토링 1단계 완료, 다음 단계 진행',
            created_at: '2026-03-30T00:00:01.000Z',
          },
        ];
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'STEP_DONE\n리팩토링 1단계 완료, 다음 단계 진행',
          newSessionId: 'session-owner-step-done-follow-up',
        });
        return {
          status: 'success',
          result: 'STEP_DONE\n리팩토링 1단계 완료, 다음 단계 진행',
          newSessionId: 'session-owner-step-done-follow-up',
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
        enqueueMessageCheck,
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
      runId: 'run-owner-step-done-follow-up',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(ownerChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'STEP_DONE\n리팩토링 1단계 완료, 다음 단계 진행',
    );
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
    expect(pairedTask.status).toBe('active');
    expect(pairedTask.round_trip_count).toBe(1);
    expect(pairedTask.owner_failure_count).toBe(0);
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({
        intentKind: 'owner-follow-up',
      }),
      'Queued paired follow-up after successful owner delivery',
    );
  });
});

describe('createMessageRuntime deferred and stale reviewer follow-ups', () => {
  it('defers reviewer enqueue after owner delivery when a CI watcher is still active', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel: Channel = {
      ...makeChannel(chatJid),
      isOwnMessage: vi.fn((msg) => msg.sender === 'owner-bot@test'),
    };
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const enqueueMessageCheck = vi.fn();
    const pairedTask = {
      id: 'task-owner-delivery-watcher-deferred',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      round_trip_count: 0,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    } as any;

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.hasActiveCiWatcherForChat).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockImplementation(
      () => pairedTask,
    );
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'human-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '이 구현 진행해줘',
        timestamp: '2026-03-30T00:00:00.000Z',
        seq: 1,
        is_bot_message: false,
      } as any,
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        pairedTask.status = 'review_ready';
        pairedTask.review_requested_at = '2026-03-30T00:00:01.000Z';
        pairedTask.round_trip_count = 1;
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'DONE\nowner complete',
          newSessionId: 'session-owner-delivery-watcher-deferred',
        });
        return {
          status: 'success',
          result: 'DONE\nowner complete',
          newSessionId: 'session-owner-delivery-watcher-deferred',
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
        enqueueMessageCheck,
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
      runId: 'run-owner-delivery-watcher-deferred',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        runId: 'run-owner-delivery-watcher-deferred',
        completedRole: 'owner',
        taskId: 'task-owner-delivery-watcher-deferred',
        taskStatus: 'review_ready',
      }),
      'Deferred paired follow-up after successful owner delivery because CI watcher is still active',
    );
  });

  it('skips a stale reviewer follow-up after owner delivery when the latest persisted turn already belongs to the reviewer', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel: Channel = {
      ...makeChannel(chatJid),
      isOwnMessage: vi.fn((msg) => msg.sender === 'owner-bot@test'),
    };
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const enqueueMessageCheck = vi.fn();
    const pairedTask = {
      id: 'task-owner-delivery-stale-reviewer-follow-up',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      round_trip_count: 0,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    } as any;
    let persistedTurnOutputs: any[] = [];

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockImplementation(
      () => pairedTask,
    );
    vi.mocked(db.getPairedTurnOutputs).mockImplementation((taskId: string) =>
      taskId === pairedTask.id ? persistedTurnOutputs : [],
    );
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'human-stale-reviewer-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '이 구현 진행해줘',
        timestamp: '2026-03-30T00:00:00.000Z',
        seq: 1,
        is_bot_message: false,
      } as any,
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        pairedTask.status = 'review_ready';
        pairedTask.review_requested_at = '2026-03-30T00:00:01.000Z';
        pairedTask.round_trip_count = 1;
        pairedTask.updated_at = '2026-03-30T00:00:02.000Z';
        persistedTurnOutputs = [
          {
            id: 1,
            task_id: pairedTask.id,
            turn_number: 1,
            role: 'owner',
            output_text: 'owner 응답',
            created_at: '2026-03-30T00:00:01.000Z',
          },
          {
            id: 2,
            task_id: pairedTask.id,
            turn_number: 2,
            role: 'reviewer',
            output_text: 'reviewer 승인',
            created_at: '2026-03-30T00:00:02.000Z',
          },
        ];
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'DONE_WITH_CONCERNS\nowner complete',
          newSessionId: 'session-owner-delivery-stale-reviewer-follow-up',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\nowner complete',
          newSessionId: 'session-owner-delivery-stale-reviewer-follow-up',
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
        enqueueMessageCheck,
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
      runId: 'run-owner-delivery-stale-reviewer-follow-up',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });
});

describe('createMessageRuntime duplicate follow-up guards and owner re-enqueue', () => {
  it('does not enqueue the same reviewer follow-up twice within the same run', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel: Channel = {
      ...makeChannel(chatJid),
      isOwnMessage: vi.fn((msg) => msg.sender === 'owner-bot@test'),
    };
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const enqueueMessageCheck = vi.fn();
    const pairedTask = {
      id: 'task-owner-delivery-dedup',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      round_trip_count: 0,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    } as any;

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockImplementation(
      () => pairedTask,
    );
    vi.mocked(db.getMessagesSince).mockImplementation(
      (_chatJid, sinceCursor) =>
        sinceCursor && sinceCursor !== '0'
          ? []
          : ([
              {
                id: 'human-dedup-1',
                chat_jid: chatJid,
                sender: 'user@test',
                sender_name: 'User',
                content: '이 구현 진행해줘',
                timestamp: '2026-03-30T00:00:00.000Z',
                seq: 1,
                is_bot_message: false,
              },
            ] as any),
    );
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        pairedTask.status = 'review_ready';
        pairedTask.review_requested_at = '2026-03-30T00:00:01.000Z';
        pairedTask.round_trip_count = 1;
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'DONE_WITH_CONCERNS\nowner complete',
          newSessionId: 'session-owner-delivery-dedup',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\nowner complete',
          newSessionId: 'session-owner-delivery-dedup',
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
        enqueueMessageCheck,
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

    await runtime.processGroupMessages(chatJid, {
      runId: 'run-owner-delivery-dedup',
      reason: 'messages',
    });
    const secondScheduled = schedulePairedFollowUpOnce({
      chatJid,
      runId: 'run-owner-delivery-dedup',
      task: pairedTask,
      intentKind: 'reviewer-turn',
      enqueue: enqueueMessageCheck,
    });

    expect(enqueueMessageCheck).toHaveBeenCalledTimes(1);
    expect(secondScheduled).toBe(false);
  });

  it('re-enqueues owner after a successful reviewer delivery moves the task back to active', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel = makeChannel(chatJid);
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const enqueueMessageCheck = vi.fn();
    const pairedTask = {
      id: 'task-reviewer-delivery-owner-follow-up',
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
    } as any;

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockImplementation(
      () => pairedTask,
    );
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: pairedTask.id,
        turn_number: 1,
        role: 'owner',
        output_text: 'STEP_DONE\nowner work ready for review',
        created_at: '2026-03-30T00:00:00.500Z',
      },
    ] as any);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        pairedTask.status = 'active';
        pairedTask.updated_at = '2026-03-30T00:00:01.000Z';
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'DONE_WITH_CONCERNS\nreviewer follow-up needed',
          newSessionId: 'session-reviewer-delivery-owner-follow-up',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\nreviewer follow-up needed',
          newSessionId: 'session-reviewer-delivery-owner-follow-up',
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
        enqueueMessageCheck,
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
      runId: 'run-reviewer-delivery-owner-follow-up',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(reviewerChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'DONE_WITH_CONCERNS\nreviewer follow-up needed',
    );
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        runId: 'run-reviewer-delivery-owner-follow-up',
        completedRole: 'reviewer',
        taskId: 'task-reviewer-delivery-owner-follow-up',
        taskStatus: 'active',
      }),
      'Queued paired follow-up after successful reviewer/arbiter delivery',
    );
  });
});

describe('createMessageRuntime finalize-owner and arbiter re-enqueue', () => {
  it('re-enqueues finalize-owner after a successful reviewer delivery moves the task to merge_ready', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel = makeChannel(chatJid);
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const enqueueMessageCheck = vi.fn();
    const pairedTask = {
      id: 'task-reviewer-delivery-finalize-owner',
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
    } as any;

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockImplementation(
      () => pairedTask,
    );
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        pairedTask.status = 'merge_ready';
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'DONE\nreview approved',
          newSessionId: 'session-reviewer-delivery-finalize-owner',
        });
        return {
          status: 'success',
          result: 'DONE\nreview approved',
          newSessionId: 'session-reviewer-delivery-finalize-owner',
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
        enqueueMessageCheck,
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
      runId: 'run-reviewer-delivery-finalize-owner',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(reviewerChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'DONE\nreview approved',
    );
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        runId: 'run-reviewer-delivery-finalize-owner',
        completedRole: 'reviewer',
        taskId: 'task-reviewer-delivery-finalize-owner',
        taskStatus: 'merge_ready',
      }),
      'Queued paired follow-up after successful reviewer/arbiter delivery',
    );
  });

  it('re-enqueues owner after a successful arbiter delivery moves the task back to active', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel = makeChannel(chatJid);
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const arbiterChannel = makeChannel(chatJid, 'discord-arbiter', false);
    const enqueueMessageCheck = vi.fn();
    const pairedTask = {
      id: 'task-arbiter-delivery-owner-follow-up',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      arbiter_service_id: 'claude-arbiter',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'arbiter_requested',
      arbiter_verdict: null,
      arbiter_requested_at: '2026-03-30T00:00:10.000Z',
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    } as any;

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockImplementation(
      () => pairedTask,
    );
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        pairedTask.status = 'active';
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'DONE_WITH_CONCERNS\narbiter says revise',
          newSessionId: 'session-arbiter-delivery-owner-follow-up',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\narbiter says revise',
          newSessionId: 'session-arbiter-delivery-owner-follow-up',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [ownerChannel, reviewerChannel, arbiterChannel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
        enqueueMessageCheck,
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
      runId: 'run-arbiter-delivery-owner-follow-up',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(arbiterChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'DONE_WITH_CONCERNS\narbiter says revise',
    );
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        runId: 'run-arbiter-delivery-owner-follow-up',
        completedRole: 'arbiter',
        taskId: 'task-arbiter-delivery-owner-follow-up',
        taskStatus: 'active',
      }),
      'Queued paired follow-up after successful reviewer/arbiter delivery',
    );
  });
});

describe('createMessageRuntime arbiter stale keys and cross-run duplicate guards', () => {
  it('re-enqueues owner after arbiter delivery even when a stale owner follow-up key exists for the prior task revision', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel = makeChannel(chatJid);
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const arbiterChannel = makeChannel(chatJid, 'discord-arbiter', false);
    const enqueueMessageCheck = vi.fn();
    const staleOwnerFollowUpEnqueue = vi.fn();
    const pairedTask = {
      id: 'task-arbiter-delivery-owner-follow-up-stale-key',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      arbiter_service_id: 'claude-arbiter',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'arbiter_requested',
      arbiter_verdict: null,
      arbiter_requested_at: '2026-03-30T00:00:10.000Z',
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:10.000Z',
    } as any;

    schedulePairedFollowUpOnce({
      chatJid,
      runId: 'run-stale-owner-follow-up',
      task: {
        id: pairedTask.id,
        status: 'active',
        round_trip_count: 1,
        updated_at: '2026-03-30T00:00:05.000Z',
      },
      intentKind: 'owner-follow-up',
      enqueue: staleOwnerFollowUpEnqueue,
    });

    expect(staleOwnerFollowUpEnqueue).toHaveBeenCalledTimes(1);

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockImplementation(
      () => pairedTask,
    );
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        pairedTask.status = 'active';
        pairedTask.arbiter_verdict = 'revise';
        pairedTask.updated_at = '2026-03-30T00:00:20.000Z';
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'DONE_WITH_CONCERNS\narbiter says revise',
          newSessionId: 'session-arbiter-delivery-owner-follow-up-stale-key',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\narbiter says revise',
          newSessionId: 'session-arbiter-delivery-owner-follow-up-stale-key',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [ownerChannel, reviewerChannel, arbiterChannel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
        enqueueMessageCheck,
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
      runId: 'run-arbiter-delivery-owner-follow-up-stale-key',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(arbiterChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'DONE_WITH_CONCERNS\narbiter says revise',
    );
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        runId: 'run-arbiter-delivery-owner-follow-up-stale-key',
        completedRole: 'arbiter',
        taskId: 'task-arbiter-delivery-owner-follow-up-stale-key',
        taskStatus: 'active',
        scheduled: true,
      }),
      'Queued paired follow-up after successful reviewer/arbiter delivery',
    );
  });

  it('does not enqueue the same reviewer follow-up twice across different runs while task state is unchanged', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel: Channel = {
      ...makeChannel(chatJid),
      isOwnMessage: vi.fn((msg) => msg.sender === 'owner-bot@test'),
    };
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const enqueueMessageCheck = vi.fn();
    const pairedTask = {
      id: 'task-owner-delivery-dedup-across-runs',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-review',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      round_trip_count: 0,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    } as any;

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockImplementation(
      () => pairedTask,
    );
    vi.mocked(db.getMessagesSince).mockImplementation(
      (_chatJid, sinceCursor) =>
        sinceCursor && sinceCursor !== '0'
          ? []
          : ([
              {
                id: 'human-dedup-across-runs-1',
                chat_jid: chatJid,
                sender: 'user@test',
                sender_name: 'User',
                content: '이 구현 진행해줘',
                timestamp: '2026-03-30T00:00:00.000Z',
                seq: 1,
                is_bot_message: false,
              },
            ] as any),
    );
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        pairedTask.status = 'review_ready';
        pairedTask.review_requested_at = '2026-03-30T00:00:01.000Z';
        pairedTask.round_trip_count = 1;
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'DONE_WITH_CONCERNS\nowner complete',
          newSessionId: 'session-owner-delivery-dedup-across-runs',
        });
        return {
          status: 'success',
          result: 'DONE_WITH_CONCERNS\nowner complete',
          newSessionId: 'session-owner-delivery-dedup-across-runs',
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
        enqueueMessageCheck,
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

    await runtime.processGroupMessages(chatJid, {
      runId: 'run-owner-delivery-dedup-1',
      reason: 'messages',
    });
    const secondScheduled = schedulePairedFollowUpOnce({
      chatJid,
      runId: 'run-owner-delivery-dedup-2',
      task: pairedTask,
      intentKind: 'reviewer-turn',
      enqueue: enqueueMessageCheck,
    });

    expect(enqueueMessageCheck).toHaveBeenCalledTimes(1);
    expect(secondScheduled).toBe(false);
  });
});
