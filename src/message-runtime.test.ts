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
  SERVICE_ID: 'claude',
  SERVICE_SESSION_SCOPE: 'claude',
  CODEX_MAIN_SERVICE_ID: 'codex-main',
  CODEX_REVIEW_SERVICE_ID: 'codex-review',
  REVIEWER_AGENT_TYPE: 'claude-code',
  ARBITER_AGENT_TYPE: undefined,
  normalizeServiceId: vi.fn((serviceId: string) => serviceId),
  isClaudeService: vi.fn(() => true),
  isReviewService: vi.fn(() => false),
  isSessionCommandSenderAllowed: vi.fn(() => false),
  getMoaConfig: vi.fn(() => ({
    enabled: false,
    referenceModels: [],
    aggregator: {},
  })),
  TIMEZONE: 'Asia/Seoul',
}));

vi.mock('./paired-execution-context.js', () => ({
  preparePairedExecutionContext: vi.fn(() => undefined),
  completePairedExecutionContext: vi.fn(),
}));

vi.mock('./db.js', () => {
  const getOpenWorkItem = vi.fn(
    (
      _chatJid?: string,
      _agentType?: 'claude-code' | 'codex',
      _serviceId?: string,
    ) => undefined,
  );
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
    claimServiceHandoff: vi.fn(() => true),
    completeServiceHandoff: vi.fn(),
    completeServiceHandoffAndAdvanceTargetCursor: vi.fn(),
    failServiceHandoff: vi.fn(),
    getAllChats: vi.fn(() => []),
    getAllTasks: vi.fn(() => []),
    getAllPendingServiceHandoffs: vi.fn(() => []),
    getLastHumanMessageTimestamp: vi.fn(() => null),
    getLastHumanMessageContent: vi.fn(() => null),
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
    getOpenWorkItem,
    getOpenWorkItemForChat: vi.fn((chatJid: string) =>
      getOpenWorkItem(chatJid),
    ),
    getLatestOpenPairedTaskForChat: vi.fn(() => undefined),
    getPairedTurnOutputs: vi.fn(() => []),
    getRecentChatMessages: vi.fn(() => []),
    createProducedWorkItem: vi.fn((input) => ({
      id: 1,
      group_folder: input.group_folder,
      chat_jid: input.chat_jid,
      agent_type: input.agent_type || 'claude-code',
      service_id: 'claude',
      delivery_role: input.delivery_role ?? null,
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
    getLastBotFinalMessage: vi.fn(() => []),
  };
});

vi.mock('./service-routing.js', () => ({
  hasReviewerLease: vi.fn(() => false),
  getEffectiveChannelLease: vi.fn((chatJid: string) => ({
    chat_jid: chatJid,
    owner_service_id: 'claude',
    reviewer_service_id: 'codex-main',
    activated_at: null,
    reason: null,
    explicit: false,
  })),
  resolveLeaseServiceId: vi.fn(
    (
      lease: {
        owner_service_id: string;
        reviewer_service_id: string | null;
        arbiter_service_id?: string | null;
      },
      role: 'owner' | 'reviewer' | 'arbiter',
    ) => {
      if (role === 'owner') return lease.owner_service_id;
      if (role === 'reviewer') return lease.reviewer_service_id;
      return lease.arbiter_service_id ?? null;
    },
  ),
  shouldServiceProcessChat: vi.fn(() => true),
}));

vi.mock('./logger.js', () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (_bindings?: Record<string, unknown>) => mockLogger,
  };
  return {
    logger: mockLogger,
    createScopedLogger: (_bindings?: Record<string, unknown>) => mockLogger,
  };
});

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
import {
  createMessageRuntime,
  resolveHandoffCursorKey,
  resolveHandoffRoleOverride,
} from './message-runtime.js';
import {
  buildPendingPairedTurn,
  resolveBotOnlyPairedFollowUpAction,
} from './message-runtime-flow.js';
import * as config from './config.js';
import { logger } from './logger.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';
import * as serviceRouting from './service-routing.js';
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

function makeChannel(
  chatJid: string,
  name = 'discord',
  ownsJid = true,
): Channel {
  return {
    name,
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAndTrack: vi.fn().mockResolvedValue('progress-1'),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => ownsJid && jid === chatJid),
    disconnect: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createMessageRuntime', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetPairedFollowUpScheduleState();
    vi.mocked(db.getLastBotFinalMessage).mockReturnValue([]);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(false);
    vi.mocked(db.getRecentChatMessages).mockReturnValue([]);
    vi.mocked(config.isClaudeService).mockReturnValue(true);
    vi.mocked(config.isReviewService).mockReturnValue(false);
  });

  it('prefers intended_role over reason prefixes for handoff role resolution', () => {
    expect(
      resolveHandoffRoleOverride({
        target_role: 'arbiter',
        intended_role: 'reviewer',
        reason: 'reviewer-claude-429',
      }),
    ).toBe('arbiter');
    expect(
      resolveHandoffRoleOverride({
        target_role: null,
        intended_role: 'reviewer',
        reason: 'claude-429',
      }),
    ).toBe('reviewer');
    expect(
      resolveHandoffRoleOverride({
        target_role: null,
        intended_role: null,
        reason: 'arbiter-claude-429',
      }),
    ).toBe('arbiter');
    expect(
      resolveHandoffRoleOverride({
        target_role: null,
        intended_role: null,
        reason: 'reviewer-claude-usage-exhausted',
      }),
    ).toBe('reviewer');
    expect(
      resolveHandoffRoleOverride({
        target_role: null,
        intended_role: null,
        reason: 'claude-usage-exhausted',
      }),
    ).toBeUndefined();
  });

  it('uses role-scoped cursor keys for reviewer and arbiter handoffs', () => {
    expect(resolveHandoffCursorKey('group@test')).toBe('group@test');
    expect(resolveHandoffCursorKey('group@test', 'owner')).toBe('group@test');
    expect(resolveHandoffCursorKey('group@test', 'reviewer')).toBe(
      'group@test:reviewer',
    );
    expect(resolveHandoffCursorKey('group@test', 'arbiter')).toBe(
      'group@test:arbiter',
    );
  });

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

  it('delivers a stale work item in a separate run before processing new messages', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const enqueueMessageCheck = vi.fn();

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
      runId: 'run-open-review-work-item-persisted-role',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(reviewerChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'reviewer final retry',
    );
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: 101,
        chatJid,
        deliveryRole: 'reviewer',
        pendingTaskStatus: 'merge_ready',
      }),
      'Skipping queued follow-up after reviewer merge_ready delivery because inline finalize will handle the handoff',
    );
  });

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
      runId: 'run-open-fallback-review-work-item-persisted-role',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(db.getOpenWorkItemForChat).toHaveBeenCalledWith(chatJid);
    expect(reviewerChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'fallback reviewer final retry',
    );
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: 102,
        chatJid,
        deliveryRole: 'reviewer',
        pendingTaskStatus: 'merge_ready',
      }),
      'Skipping queued follow-up after reviewer merge_ready delivery because inline finalize will handle the handoff',
    );
  });

  it('does not inject filtered raw bot finals into workspace-based review prompts', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};
    const ownerChannel: Channel = {
      ...makeChannel(chatJid),
      isOwnMessage: vi.fn((msg) => msg.sender === 'owner-bot@test'),
    };
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);

    vi.mocked(config.isClaudeService).mockReturnValue(false);
    vi.mocked(config.isReviewService).mockReturnValue(false);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-1',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 0,
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    });
    vi.mocked(db.getLastHumanMessageContent).mockReturnValue(
      '버전 올리고 dev 머지까지 해줘',
    );
    vi.mocked(db.getLatestMessageSeqAtOrBefore).mockReturnValue(41);
    vi.mocked(db.getMessagesSinceSeq).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'owner-bot@test',
        sender_name: 'Owner Bot',
        content: 'DONE 이전 final이 여기 붙으면 안 됩니다.',
        timestamp: '2026-03-30T00:00:05.000Z',
        is_bot_message: true,
      } as any,
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        expect(input.prompt).toContain(
          'User request:\n---\n버전 올리고 dev 머지까지 해줘\n---',
        );
        expect(input.prompt).toContain(
          'Review the latest owner changes in the workspace.',
        );
        expect(input.prompt).not.toContain(
          'DONE 이전 final이 여기 붙으면 안 됩니다.',
        );
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '리뷰 확인 완료',
          newSessionId: 'session-review-sanitized',
        });
        return {
          status: 'success',
          result: '리뷰 확인 완료',
          newSessionId: 'session-review-sanitized',
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
      runId: 'run-review-prompt-sanitized',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(lastAgentTimestamps[`${chatJid}:reviewer`]).toBe('41');
    expect(saveState).toHaveBeenCalled();
    expect(db.createProducedWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ delivery_role: 'reviewer' }),
    );
    expect(reviewerChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      '리뷰 확인 완료',
    );
  });

  it('skips reviewer final work item delivery when a direct terminal IPC message was already recorded for the run', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel: Channel = {
      ...makeChannel(chatJid),
      isOwnMessage: vi.fn((msg) => msg.sender === 'owner-bot@test'),
    };
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const noteDirectTerminalDelivery = vi.fn();

    vi.mocked(config.isClaudeService).mockReturnValue(false);
    vi.mocked(config.isReviewService).mockReturnValue(false);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-review-direct-terminal',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 0,
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    });
    vi.mocked(db.getLastHumanMessageContent).mockReturnValue('리뷰해줘');
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '**DONE**\n\n리뷰 승인',
          newSessionId: 'session-review-direct-terminal',
        });
        return {
          status: 'success',
          result: '**DONE**\n\n리뷰 승인',
          newSessionId: 'session-review-direct-terminal',
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
        noteDirectTerminalDelivery,
        hasDirectTerminalDeliveryForRun: vi.fn(
          (groupJid: string, runId: string, senderRole?: string | null) =>
            groupJid === chatJid &&
            runId === 'run-review-direct-terminal-skip' &&
            senderRole === 'reviewer',
        ),
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
      runId: 'run-review-direct-terminal-skip',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(noteDirectTerminalDelivery).not.toHaveBeenCalled();
    expect(db.createProducedWorkItem).not.toHaveBeenCalled();
    expect(reviewerChannel.sendMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        runId: 'run-review-direct-terminal-skip',
        deliveryRole: 'reviewer',
      }),
      'Skipping final work item delivery because this run already sent a direct terminal IPC message',
    );
  });

  it('does not suppress reviewer finals based on streamed terminal output alone', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel: Channel = {
      ...makeChannel(chatJid),
      isOwnMessage: vi.fn((msg) => msg.sender === 'owner-bot@test'),
    };
    const reviewerChannel = makeChannel(chatJid, 'discord-review', false);
    const noteDirectTerminalDelivery = vi.fn();

    vi.mocked(config.isClaudeService).mockReturnValue(false);
    vi.mocked(config.isReviewService).mockReturnValue(false);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-review-streamed-terminal',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 0,
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    });
    vi.mocked(db.getLastHumanMessageContent).mockReturnValue('리뷰해줘');
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '**DONE**\n\n리뷰 승인',
          newSessionId: 'session-review-streamed-terminal',
        });
        return {
          status: 'success',
          result: '**DONE**\n\n리뷰 승인',
          newSessionId: 'session-review-streamed-terminal',
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
        noteDirectTerminalDelivery,
        hasDirectTerminalDeliveryForRun: vi.fn(() => false),
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
      runId: 'run-review-streamed-terminal',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(noteDirectTerminalDelivery).not.toHaveBeenCalled();
    expect(db.createProducedWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_role: 'reviewer',
        result_payload: '**DONE**\n\n리뷰 승인',
      }),
    );
    expect(reviewerChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      '**DONE**\n\n리뷰 승인',
    );
  });

  it('does not suppress owner finals even if the queue reports a direct terminal delivery for the run', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const noteDirectTerminalDelivery = vi.fn();
    const hasDirectTerminalDeliveryForRun = vi.fn(() => true);

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
          phase: 'final',
          result: '**DONE**\n\nowner final',
          newSessionId: 'session-owner-terminal',
        });
        return {
          status: 'success',
          result: '**DONE**\n\nowner final',
          newSessionId: 'session-owner-terminal',
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
        noteDirectTerminalDelivery,
        hasDirectTerminalDeliveryForRun,
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
      runId: 'run-owner-direct-terminal-ignore',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(noteDirectTerminalDelivery).not.toHaveBeenCalled();
    expect(hasDirectTerminalDeliveryForRun).not.toHaveBeenCalled();
    expect(db.createProducedWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        result_payload: '**DONE**\n\nowner final',
      }),
    );
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      '**DONE**\n\nowner final',
    );
  });

  it('includes the latest reviewer summary in merge_ready finalize prompts and truncates it', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const longReviewerOutput = `검토 요약 ${'a'.repeat(2105)} 끝`;
    const truncatedReviewerOutput = longReviewerOutput.slice(0, 2000);

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-merge-ready',
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
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-merge-ready',
        turn_number: 1,
        role: 'reviewer',
        output_text: '이전 reviewer 요약',
        created_at: '2026-03-30T00:00:01.000Z',
      },
      {
        id: 2,
        task_id: 'task-merge-ready',
        turn_number: 2,
        role: 'owner',
        output_text: 'owner 중간 응답',
        created_at: '2026-03-30T00:00:02.000Z',
      },
      {
        id: 3,
        task_id: 'task-merge-ready',
        turn_number: 3,
        role: 'reviewer',
        output_text: longReviewerOutput,
        created_at: '2026-03-30T00:00:03.000Z',
      },
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        expect(input.prompt).toBe(
          `The reviewer approved your work (DONE). Finalize and report the result.
If you intend to close this paired turn now, your first line must be DONE.
If your first line is DONE_WITH_CONCERNS, the system will reopen review instead of finishing.\n\nReviewer's final assessment:\n${truncatedReviewerOutput}`,
        );
        expect(input.prompt).not.toContain(longReviewerOutput);
        expect(input.prompt).not.toContain('이전 reviewer 요약');
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '최종 정리 완료',
          newSessionId: 'session-finalize-merge-ready',
        });
        return {
          status: 'success',
          result: '최종 정리 완료',
          newSessionId: 'session-finalize-merge-ready',
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
      runId: 'run-merge-ready-finalize-summary',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(db.createProducedWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ delivery_role: 'owner' }),
    );
    expect(channel.sendMessage).toHaveBeenCalledWith(chatJid, '최종 정리 완료');
  });

  it('uses the finalize prompt for merge_ready bot-only reviewer follow-ups', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-merge-ready-bot-follow-up',
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
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-merge-ready-bot-follow-up',
        turn_number: 1,
        role: 'reviewer',
        output_text: '리뷰 승인 요약',
        created_at: '2026-03-30T00:00:03.000Z',
      },
    ]);
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'reviewer-bot-message',
        chat_jid: chatJid,
        sender: 'reviewer-bot@test',
        sender_name: '리뷰어',
        content: 'DONE\n승인합니다.',
        timestamp: '2026-03-30T00:00:04.000Z',
        seq: 42,
        is_bot_message: true,
      } as any,
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        expect(input.prompt).toBe(
          "The reviewer approved your work (DONE). Finalize and report the result.\nIf you intend to close this paired turn now, your first line must be DONE.\nIf your first line is DONE_WITH_CONCERNS, the system will reopen review instead of finishing.\n\nReviewer's final assessment:\n리뷰 승인 요약",
        );
        expect(input.prompt).not.toContain('DONE\n승인합니다.');
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '최종 정리 완료',
          newSessionId: 'session-finalize-bot-follow-up',
        });
        return {
          status: 'success',
          result: '최종 정리 완료',
          newSessionId: 'session-finalize-bot-follow-up',
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
      runId: 'run-merge-ready-bot-follow-up',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(chatJid, '최종 정리 완료');
    expect(lastAgentTimestamps[chatJid]).toBe('42');
    expect(saveState).toHaveBeenCalled();
  });

  it('does not build a second reviewer pending turn once the latest persisted turn already belongs to the reviewer', () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    const task = {
      id: 'task-stale-reviewer-bot-message',
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
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-stale-reviewer-bot-message',
        turn_number: 1,
        role: 'owner',
        output_text: 'owner 응답',
        created_at: '2026-03-30T00:00:01.000Z',
      },
      {
        id: 2,
        task_id: 'task-stale-reviewer-bot-message',
        turn_number: 2,
        role: 'reviewer',
        output_text: 'reviewer 승인',
        created_at: '2026-03-30T00:00:02.000Z',
      },
    ]);

    expect(
      buildPendingPairedTurn({
        chatJid,
        timezone: 'UTC',
        task,
        rawMissedMessages: [
          {
            seq: 42,
            timestamp: '2026-03-30T00:00:04.000Z',
          },
        ],
        recentHumanMessages: [],
        labeledRecentMessages: [],
        resolveChannel: () => makeChannel(chatJid, 'discord-review', false),
      }),
    ).toBeNull();

    expect(
      resolveBotOnlyPairedFollowUpAction({
        chatJid,
        task,
        isBotOnlyPairedFollowUp: true,
        pendingCursorSource: {
          seq: 42,
          timestamp: '2026-03-30T00:00:04.000Z',
        },
      }),
    ).toEqual({
      kind: 'consume-stale-bot-message',
      task,
      cursor: 42,
      currentStatus: 'review_ready',
    });
  });

  it('requeues the reviewer follow-up once owner output is persisted under review_ready', () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const task = {
      id: 'task-reviewer-follow-up-after-owner-output',
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
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-reviewer-follow-up-after-owner-output',
        turn_number: 1,
        role: 'owner',
        output_text: 'owner 응답',
        created_at: '2026-03-30T00:00:01.000Z',
      },
    ]);

    expect(
      resolveBotOnlyPairedFollowUpAction({
        chatJid,
        task,
        isBotOnlyPairedFollowUp: true,
        pendingCursorSource: {
          seq: 42,
          timestamp: '2026-03-30T00:00:04.000Z',
        },
      }),
    ).toEqual({
      kind: 'requeue-pending-turn',
      task,
      cursor: 42,
      cursorKey: `${chatJid}:reviewer`,
      intentKind: 'reviewer-turn',
      nextRole: 'reviewer',
    });
  });

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
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'human-dedup-1',
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
      getRegisteredGroups: () => ({ [chatJid]: group }),
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
    await runtime.processGroupMessages(chatJid, {
      runId: 'run-owner-delivery-dedup',
      reason: 'messages',
    });

    expect(enqueueMessageCheck).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        runId: 'run-owner-delivery-dedup',
        completedRole: 'owner',
        taskId: 'task-owner-delivery-dedup',
        taskStatus: 'review_ready',
        scheduled: false,
      }),
      'Skipped duplicate paired follow-up after successful owner delivery while task state was unchanged',
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
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'human-dedup-across-runs-1',
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
      getRegisteredGroups: () => ({ [chatJid]: group }),
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
    await runtime.processGroupMessages(chatJid, {
      runId: 'run-owner-delivery-dedup-2',
      reason: 'drain',
    });

    expect(enqueueMessageCheck).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        runId: 'run-owner-delivery-dedup-2',
        completedRole: 'owner',
        taskId: 'task-owner-delivery-dedup-across-runs',
        taskStatus: 'review_ready',
        scheduled: false,
      }),
      'Skipped duplicate paired follow-up after successful owner delivery while task state was unchanged',
    );
  });

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

  it('consumes stale bot-only owner messages once the finalize turn output is already persisted', () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    const task = {
      id: 'task-stale-owner-bot-message',
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
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-stale-owner-bot-message',
        turn_number: 1,
        role: 'reviewer',
        output_text: 'reviewer 승인',
        created_at: '2026-03-30T00:00:01.000Z',
      },
      {
        id: 2,
        task_id: 'task-stale-owner-bot-message',
        turn_number: 2,
        role: 'owner',
        output_text: 'owner 최종 보고',
        created_at: '2026-03-30T00:00:02.000Z',
      },
    ]);

    expect(
      buildPendingPairedTurn({
        chatJid,
        timezone: 'UTC',
        task,
        rawMissedMessages: [
          {
            seq: 43,
            timestamp: '2026-03-30T00:00:04.000Z',
          },
        ],
        recentHumanMessages: [],
        labeledRecentMessages: [],
        resolveChannel: () => makeChannel(chatJid),
      }),
    ).toBeNull();

    expect(
      resolveBotOnlyPairedFollowUpAction({
        chatJid,
        task,
        isBotOnlyPairedFollowUp: true,
        pendingCursorSource: {
          seq: 43,
          timestamp: '2026-03-30T00:00:04.000Z',
        },
      }),
    ).toEqual({
      kind: 'consume-stale-bot-message',
      task,
      cursor: 43,
      currentStatus: 'merge_ready',
    });
  });

  it('runs merge_ready bot-only reviewer follow-ups inline in the message loop', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const enqueueMessageCheck = vi.fn();
    const closeStdin = vi.fn();
    const sendMessage = vi.fn(() => false);
    const setLastTimestamp = vi.fn();
    const stopLoop = new Error('stop-message-loop');

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-merge-ready-inline-loop',
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
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-merge-ready-inline-loop',
        turn_number: 1,
        role: 'reviewer',
        output_text: '리뷰 승인 요약',
        created_at: '2026-03-30T00:00:03.000Z',
      },
    ]);
    vi.mocked(db.getNewMessages).mockReturnValue({
      messages: [
        {
          id: 'reviewer-bot-message-inline-loop',
          chat_jid: chatJid,
          sender: 'reviewer-bot@test',
          sender_name: '리뷰어',
          content: 'DONE\n승인합니다.',
          timestamp: '2026-03-30T00:00:04.000Z',
          seq: 42,
          is_bot_message: true,
        } as any,
      ],
      newTimestamp: '42',
    });
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        expect(input.prompt).toBe(
          "The reviewer approved your work (DONE). Finalize and report the result.\nIf you intend to close this paired turn now, your first line must be DONE.\nIf your first line is DONE_WITH_CONCERNS, the system will reopen review instead of finishing.\n\nReviewer's final assessment:\n리뷰 승인 요약",
        );
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '최종 정리 완료',
          newSessionId: 'session-inline-loop-finalize',
        });
        return {
          status: 'success',
          result: '최종 정리 완료',
          newSessionId: 'session-inline-loop-finalize',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 60_000,
      pollInterval: 123,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin,
        enqueueMessageCheck,
        notifyIdle: vi.fn(),
        sendMessage,
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp,
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((
      handler: any,
      timeout?: number,
      ...args: any[]
    ) => {
      if (timeout === 123) {
        throw stopLoop;
      }
      return (originalSetTimeout as any)(handler, timeout, ...args);
    }) as typeof setTimeout);

    try {
      await expect(runtime.startMessageLoop()).rejects.toThrow(
        stopLoop.message,
      );
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(setLastTimestamp).toHaveBeenCalledWith('42');
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(chatJid, '최종 정리 완료');
    expect(closeStdin).not.toHaveBeenCalledWith(
      chatJid,
      expect.objectContaining({ reason: 'paired-pending-turn-follow-up' }),
    );
    expect(enqueueMessageCheck).not.toHaveBeenCalledWith(
      chatJid,
      resolveGroupIpcPath(group.folder),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        taskId: 'task-merge-ready-inline-loop',
        taskStatus: 'merge_ready',
        handoffMode: 'inline-finalize',
        nextRole: 'owner',
        cursor: 42,
      }),
      'Executing merge_ready finalize turn inline after bot-only reviewer follow-up',
    );
  });

  it('requeues owner follow-ups from reviewer bot-only messages instead of piping them into the active run', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const enqueueMessageCheck = vi.fn();
    const closeStdin = vi.fn();
    const sendMessage = vi.fn(() => false);
    const setLastTimestamp = vi.fn();
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};
    const stopLoop = new Error('stop-message-loop');

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-active-owner-follow-up-loop',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    });
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-active-owner-follow-up-loop',
        turn_number: 1,
        role: 'owner',
        output_text: 'owner 초안',
        created_at: '2026-03-30T00:00:01.000Z',
      },
      {
        id: 2,
        task_id: 'task-active-owner-follow-up-loop',
        turn_number: 2,
        role: 'reviewer',
        output_text: 'reviewer 수정 요청',
        created_at: '2026-03-30T00:00:02.000Z',
      },
    ]);
    vi.mocked(db.getNewMessages).mockReturnValue({
      messages: [
        {
          id: 'reviewer-bot-message-owner-follow-up-loop',
          chat_jid: chatJid,
          sender: 'reviewer-bot@test',
          sender_name: '리뷰어',
          content: 'DONE_WITH_CONCERNS\n\nreviewer direct message',
          timestamp: '2026-03-30T00:00:04.000Z',
          seq: 42,
          is_bot_message: true,
        } as any,
      ],
      newTimestamp: '42',
    });

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 60_000,
      pollInterval: 123,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin,
        enqueueMessageCheck,
        notifyIdle: vi.fn(),
        sendMessage,
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp,
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const originalSetTimeout = global.setTimeout;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((
      handler: any,
      timeout?: number,
      ...args: any[]
    ) => {
      if (timeout === 123) {
        throw stopLoop;
      }
      return (originalSetTimeout as any)(handler, timeout, ...args);
    }) as typeof setTimeout);

    try {
      await expect(runtime.startMessageLoop()).rejects.toThrow(
        stopLoop.message,
      );
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(setLastTimestamp).toHaveBeenCalledWith('42');
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(closeStdin).toHaveBeenCalledWith(
      chatJid,
      expect.objectContaining({ reason: 'paired-pending-turn-follow-up' }),
    );
    expect(enqueueMessageCheck).toHaveBeenCalledWith(
      chatJid,
      resolveGroupIpcPath(group.folder),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('auto-runs an owner follow-up when a task returns to active after reviewer feedback', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-active-owner-follow-up',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    });
    vi.mocked(db.getMessagesSince).mockReturnValue([]);
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-active-owner-follow-up',
        turn_number: 1,
        role: 'owner',
        output_text: 'owner 초안',
        created_at: '2026-03-30T00:00:01.000Z',
      },
      {
        id: 2,
        task_id: 'task-active-owner-follow-up',
        turn_number: 2,
        role: 'reviewer',
        output_text: '리뷰어가 수정 요청을 남김',
        created_at: '2026-03-30T00:00:02.000Z',
      },
    ]);
    vi.mocked(db.getRecentChatMessages).mockReturnValue([
      {
        id: 'human-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: '눈쟁이',
        content: '이 기능 마무리해줘',
        timestamp: '2026-03-30T00:00:00.500Z',
        seq: 1,
        is_bot_message: false,
      } as any,
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        expect(input.prompt).toContain('이 기능 마무리해줘');
        expect(input.prompt).toContain('리뷰어가 수정 요청을 남김');
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'owner가 reviewer 피드백을 반영했습니다.',
          newSessionId: 'session-owner-follow-up',
        });
        return {
          status: 'success',
          result: 'owner가 reviewer 피드백을 반영했습니다.',
          newSessionId: 'session-owner-follow-up',
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
      runId: 'run-active-owner-follow-up',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'owner가 reviewer 피드백을 반영했습니다.',
    );
  });

  it('builds owner follow-up prompts from paired turn outputs instead of raw reviewer bot delivery text', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-active-bot-follow-up',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:00.000Z',
      round_trip_count: 1,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:00.000Z',
      updated_at: '2026-03-30T00:00:00.000Z',
    });
    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'reviewer-bot-message-active',
        chat_jid: chatJid,
        sender: 'reviewer-bot@test',
        sender_name: '리뷰어',
        content: 'DONE_WITH_CONCERNS\n\n리뷰어 디스코드 출력 원문',
        timestamp: '2026-03-30T00:00:04.000Z',
        seq: 42,
        is_bot_message: true,
      } as any,
    ]);
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-active-bot-follow-up',
        turn_number: 1,
        role: 'owner',
        output_text: 'owner 초안',
        created_at: '2026-03-30T00:00:01.000Z',
      },
      {
        id: 2,
        task_id: 'task-active-bot-follow-up',
        turn_number: 2,
        role: 'reviewer',
        output_text: 'paired_turn_outputs 에 저장된 reviewer 요약',
        created_at: '2026-03-30T00:00:02.000Z',
      },
    ]);
    vi.mocked(db.getRecentChatMessages).mockReturnValue([
      {
        id: 'human-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: '눈쟁이',
        content: '이 기능 마무리해줘',
        timestamp: '2026-03-30T00:00:00.500Z',
        seq: 1,
        is_bot_message: false,
      } as any,
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        expect(input.prompt).toContain(
          'paired_turn_outputs 에 저장된 reviewer 요약',
        );
        expect(input.prompt).not.toContain('리뷰어 디스코드 출력 원문');
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'owner follow-up ok',
          newSessionId: 'session-owner-bot-follow-up',
        });
        return {
          status: 'success',
          result: 'owner follow-up ok',
          newSessionId: 'session-owner-bot-follow-up',
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
      runId: 'run-active-bot-follow-up',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'owner follow-up ok',
    );
  });

  it('reuses the shared arbiter prompt builder for pending arbiter turns', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const ownerChannel = makeChannel(chatJid);
    const arbiterChannel = makeChannel(chatJid, 'discord-arbiter', false);

    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue({
      id: 'task-arbiter',
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
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: 'task-arbiter',
        turn_number: 1,
        role: 'owner',
        output_text: 'owner 산출물',
        created_at: '2026-03-30T00:00:01.000Z',
      },
      {
        id: 2,
        task_id: 'task-arbiter',
        turn_number: 2,
        role: 'reviewer',
        output_text: 'reviewer 이견',
        created_at: '2026-03-30T00:00:02.000Z',
      },
    ]);
    vi.mocked(db.getRecentChatMessages).mockReturnValue([
      {
        id: 'human-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: '추가 맥락',
        timestamp: '2026-03-30T00:00:00.500Z',
        is_bot_message: false,
      } as any,
      {
        id: 'bot-1',
        chat_jid: chatJid,
        sender: 'bot@test',
        sender_name: 'Bot',
        content: 'bot progress',
        timestamp: '2026-03-30T00:00:03.000Z',
        is_bot_message: true,
      } as any,
    ]);
    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, input, _onProcess, onOutput) => {
        expect(input.prompt).toContain('<task-id>task-arbiter</task-id>');
        expect(input.prompt).toContain('<round-trips>3</round-trips>');
        expect(input.prompt).toContain('추가 맥락');
        expect(input.prompt).toContain('owner 산출물');
        expect(input.prompt).toContain('reviewer 이견');
        expect(input.prompt).not.toContain('bot progress');
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: 'arbiter 확인 완료',
          newSessionId: 'session-arbiter-pending',
        });
        return {
          status: 'success',
          result: 'arbiter 확인 완료',
          newSessionId: 'session-arbiter-pending',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [ownerChannel, arbiterChannel],
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
      runId: 'run-arbiter-pending-shared-prompt',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(arbiterChannel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'arbiter 확인 완료',
    );
  });

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
      runId: 'run-normal-arbiter-missing-channel',
      reason: 'messages',
    });

    expect(result).toBe(false);
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(ownerChannel.sendMessage).not.toHaveBeenCalled();
  });

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
      owner_service_id: 'claude',
      reviewer_service_id: 'claude',
      arbiter_service_id: null,
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
      owner_service_id: 'claude',
      reviewer_service_id: 'claude',
      arbiter_service_id: null,
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
      runId: 'run-fixed-arbiter-bot-history',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
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
        runId: 'run-progress-structured-silent',
        reason: 'messages',
      });

      expect(result).toBe(true);
      expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
      expect(channel.sendMessage).toHaveBeenCalledTimes(1);
      expect(channel.sendMessage).toHaveBeenCalledWith(
        chatJid,
        '첫 번째 진행상황입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('promotes the last flushed progress output to a final message when the agent completes without a final phase', async () => {
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
      // Once the tracked progress exists, later progress updates replace the visible heading directly.
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

  it('keeps going after a tracked progress edit fails and still emits the last flushed final message', async () => {
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
      runId: 'run-missing-phase-final',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'phase 없는 최종 응답입니다.',
    );
  });

  it('recovery queues a group when an open work item is waiting for delivery', () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const enqueueMessageCheck = vi.fn();
    const enqueueTask = vi.fn();

    vi.mocked(db.getOpenWorkItem).mockReturnValue({
      id: 99,
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: 'claude-code',
      service_id: 'claude',
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
        enqueueTask,
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
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(db.getMessagesSinceSeq).not.toHaveBeenCalled();
  });

  it('recovery also queues fallback delivery retries across agent types', () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const enqueueMessageCheck = vi.fn();
    const enqueueTask = vi.fn();

    vi.mocked(db.getOpenWorkItem).mockReturnValue(undefined);
    vi.mocked(db.getOpenWorkItemForChat).mockReturnValue({
      id: 199,
      group_folder: group.folder,
      chat_jid: chatJid,
      agent_type: 'codex',
      service_id: 'codex-review',
      delivery_role: 'reviewer',
      status: 'delivery_retry',
      start_seq: 5,
      end_seq: 6,
      result_payload: '미전달 reviewer 결과',
      delivery_attempts: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      delivered_at: null,
      delivery_message_id: null,
      last_error: 'discord send failed',
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
        enqueueTask,
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

    expect(db.getOpenWorkItemForChat).toHaveBeenCalledWith(chatJid);
    expect(enqueueMessageCheck).toHaveBeenCalledWith(
      chatJid,
      resolveGroupIpcPath(group.folder),
    );
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(db.getMessagesSinceSeq).not.toHaveBeenCalled();
  });
});
