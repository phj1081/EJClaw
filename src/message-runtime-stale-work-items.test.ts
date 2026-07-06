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
import * as pairedExecutionContext from './paired-execution-context.js';
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

describe('createMessageRuntime stale work item delivery', () => {
  it('delivers a stale work item in a separate run before processing new messages', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const enqueueMessageCheck = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(db.getOpenWorkItem).mockReturnValue({
      id: 99,
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: 'codex',
      service_id: 'claude',
      status: 'delivery_retry',
      start_seq: 1,
      end_seq: 1,
      result_payload: '이전 final입니다.',
      delivery_attempts: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
      delivery_message_id: null,
      last_error: 'discord send failed',
    });
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '새 작업입니다.',
        timestamp: '2026-03-30T00:00:00.000Z',
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
        enqueueMessageCheck,
      } as any,
      getRoomBindings: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-open-work-item-first',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      '이전 final입니다.',
    );
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
  });

  it('suppresses a stale owner work item when a new human message supersedes a merge_ready task', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const enqueueMessageCheck = vi.fn();
    const oldTask = {
      id: 'task-merge-ready-old',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'merge_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    } as any;
    const newTask = {
      ...oldTask,
      id: 'task-fresh-owner-turn',
      status: 'active',
      completion_reason: null,
      created_at: '2026-03-30T00:00:05.000Z',
      updated_at: '2026-03-30T00:00:05.000Z',
    } as any;

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getOpenWorkItem).mockReturnValue({
      id: 99,
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: 'codex',
      service_id: 'claude',
      delivery_role: 'owner',
      status: 'delivery_retry',
      start_seq: 1,
      end_seq: 1,
      result_payload: '이전 final입니다.',
      delivery_attempts: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
      delivery_message_id: null,
      last_error: 'discord send failed',
    });
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '새 작업입니다.',
        timestamp: '2026-03-30T00:00:10.000Z',
        seq: 10,
      },
    ]);
    vi.mocked(db.getLatestOpenPairedTaskForChat)
      .mockReturnValueOnce(oldTask)
      .mockReturnValue(newTask);
    vi.mocked(
      pairedExecutionContext.resolveOwnerTaskForHumanMessage,
    ).mockReturnValue({
      task: newTask,
      supersededTask: oldTask,
    });
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        expect(input.prompt).toContain('새 작업입니다.');
        expect(input.prompt).not.toContain('이전 final입니다.');
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'DONE\n새 작업 처리',
          output: { visibility: 'public', text: 'DONE\n새 작업 처리' },
        } as any);
        return {
          status: 'success',
          result: 'DONE\n새 작업 처리',
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
      runId: 'run-supersede-owner-work-item',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(db.markWorkItemDelivered).toHaveBeenCalledWith(99);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).not.toHaveBeenCalledWith(
      chatJid,
      '이전 final입니다.',
    );
  });
});

describe('createMessageRuntime stale work item suppression', () => {
  it('suppresses a stale owner work item when a new human message arrives while the paired task is still active', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const enqueueMessageCheck = vi.fn();
    const activeTask = {
      id: 'task-active-owner-follow-up',
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
      updated_at: '2026-03-30T00:00:05.000Z',
    } as any;

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getOpenWorkItem).mockReturnValue({
      id: 109,
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: 'codex',
      service_id: 'claude',
      delivery_role: 'owner',
      status: 'delivery_retry',
      start_seq: 1,
      end_seq: 1,
      result_payload: '이전 step 결과입니다.',
      delivery_attempts: 1,
      created_at: '2026-03-30T00:00:05.000Z',
      updated_at: '2026-03-30T00:00:05.000Z',
      delivered_at: null,
      delivery_message_id: null,
      last_error: 'discord send failed',
    });
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-2',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '이전 답 말고 이 방향으로 진행해줘',
        timestamp: '2026-03-30T00:00:10.000Z',
        seq: 2,
      },
    ]);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(activeTask);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        expect(input.prompt).toContain('이 방향으로 진행해줘');
        expect(input.prompt).not.toContain('이전 step 결과입니다.');
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'STEP_DONE\n새 입력 기준으로 계속 진행',
          output: {
            visibility: 'public',
            text: 'STEP_DONE\n새 입력 기준으로 계속 진행',
          },
        } as any);
        return {
          status: 'success',
          result: 'STEP_DONE\n새 입력 기준으로 계속 진행',
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
      runId: 'run-suppress-stale-active-owner-work-item',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(db.markWorkItemDelivered).toHaveBeenCalledWith(109);
    expect(channel.sendMessage).not.toHaveBeenCalledWith(
      chatJid,
      '이전 step 결과입니다.',
    );
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        workItemId: 109,
        taskId: 'task-active-owner-follow-up',
        taskStatus: 'active',
      }),
      'Suppressed stale owner delivery retry because a new human message arrived while the paired task was still active',
    );
  });

  it('suppresses duplicate stale work item delivery and logs the suppression reason', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const enqueueMessageCheck = vi.fn();

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getOpenWorkItem).mockReturnValue({
      id: 199,
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: 'codex',
      service_id: 'claude',
      delivery_role: 'owner',
      status: 'delivery_retry',
      start_seq: 1,
      end_seq: 1,
      result_payload: '같은 최종 답변입니다.',
      delivery_attempts: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
      delivery_message_id: null,
      last_error: 'discord send failed',
    });
    vi.mocked(db.getLastBotFinalMessage).mockReturnValue([
      {
        id: 'last-final',
        chat_jid: chatJid,
        sender: 'reviewer-bot@test',
        sender_name: '리뷰어',
        content: '같은 최종 답변입니다.',
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: true,
      } as any,
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
      runId: 'run-open-work-item-duplicate-suppressed',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(db.markWorkItemDelivered).toHaveBeenCalledWith(199, null);
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        channelName: 'discord',
        workItemId: 199,
        deliveryRole: 'owner',
        suppressionReason: 'paired-final-duplicate',
        preview: '같은 최종 답변입니다.',
      }),
      'Suppressed duplicate final message in paired room (marked as delivered)',
    );
  });
});

describe('createMessageRuntime stale reviewer work item retries', () => {
  it('retries a stale reviewer work item when the reviewer channel is missing', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel = makeChannel(chatJid);
    const enqueueMessageCheck = vi.fn();

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getOpenWorkItem).mockReturnValue({
      id: 100,
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: 'codex',
      service_id: 'claude',
      delivery_role: 'reviewer',
      status: 'delivery_retry',
      start_seq: 10,
      end_seq: 11,
      result_payload: 'reviewer final',
      delivery_attempts: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
      delivery_message_id: null,
      last_error: 'missing role channel',
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-review-delivery',
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
    });

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
      runId: 'run-open-review-work-item-missing-channel',
      reason: 'messages',
    });

    expect(result).toBe(false);
    expect(db.markWorkItemDeliveryRetry).toHaveBeenCalledWith(
      100,
      expect.stringContaining('discord-review'),
    );
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('does not queue a second merge_ready follow-up after delivering a stale reviewer work item', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel = makeChannel(chatJid);
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const enqueueMessageCheck = vi.fn();

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getOpenWorkItem).mockReturnValue({
      id: 101,
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: 'codex',
      service_id: 'claude',
      delivery_role: 'reviewer',
      status: 'delivery_retry',
      start_seq: 10,
      end_seq: 11,
      result_payload: 'reviewer final retry',
      delivery_attempts: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
      delivery_message_id: null,
      last_error: 'discord send failed',
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-review-delivery-role',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'merge_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    });

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
      runId: 'run-open-review-work-item-persisted-role',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(reviewerChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'reviewer final retry',
    );
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: 101,
        chatJid,
        deliveryRole: 'reviewer',
        taskId: 'task-review-delivery-role',
        pendingTaskStatus: 'merge_ready',
        intentKind: 'finalize-owner-turn',
      }),
      'Queued paired follow-up after delivery retry',
    );
  });
});

describe('createMessageRuntime fallback reviewer deliveries', () => {
  it('does not queue a second merge_ready follow-up for fallback reviewer deliveries either', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const ownerChannel = makeChannel(chatJid);
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const enqueueMessageCheck = vi.fn();

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getOpenWorkItem).mockReturnValue(undefined);
    vi.mocked(db.getOpenWorkItemForChat).mockReturnValue({
      id: 102,
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: 'codex',
      service_id: 'codex-review',
      delivery_role: 'reviewer',
      status: 'delivery_retry',
      start_seq: 12,
      end_seq: 13,
      result_payload: 'fallback reviewer final retry',
      delivery_attempts: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
      delivery_message_id: null,
      last_error: 'discord send failed',
    });
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-fallback-review-delivery-role',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'merge_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    });

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
      runId: 'run-open-fallback-review-work-item-persisted-role',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(db.getOpenWorkItemForChat).toHaveBeenCalledWith(chatJid, 'claude');
    expect(reviewerChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'fallback reviewer final retry',
    );
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).toHaveBeenCalledWith(chatJid);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: 102,
        chatJid,
        deliveryRole: 'reviewer',
        taskId: 'task-fallback-review-delivery-role',
        pendingTaskStatus: 'merge_ready',
        intentKind: 'finalize-owner-turn',
      }),
      'Queued paired follow-up after delivery retry',
    );
  });
});
