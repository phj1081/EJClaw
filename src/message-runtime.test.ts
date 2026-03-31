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
    getOpenWorkItem: vi.fn(() => undefined),
    getPendingServiceHandoffs: vi.fn(() => []),
    getLatestOpenPairedTaskForChat: vi.fn(() => undefined),
    getPairedTurnOutputs: vi.fn(() => []),
    getRecentChatMessages: vi.fn(() => []),
    createProducedWorkItem: vi.fn((input) => ({
      id: 1,
      group_folder: input.group_folder,
      chat_jid: input.chat_jid,
      agent_type: input.agent_type || 'claude-code',
      service_id: 'claude',
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
  shouldServiceProcessChat: vi.fn(() => true),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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
import * as config from './config.js';
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
    vi.resetAllMocks();
    vi.mocked(db.getLastBotFinalMessage).mockReturnValue([]);
    vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(false);
    vi.mocked(db.getRecentChatMessages).mockReturnValue([]);
    vi.mocked(config.isClaudeService).mockReturnValue(true);
    vi.mocked(config.isReviewService).mockReturnValue(false);
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

  it('does not inject filtered raw bot finals into workspace-based review prompts', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};
    const channel: Channel = {
      ...makeChannel(chatJid),
      isOwnMessage: vi.fn((msg) => msg.sender === 'owner-bot@test'),
    };

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
      runId: 'run-review-prompt-sanitized',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(lastAgentTimestamps[`${chatJid}:reviewer`]).toBe('41');
    expect(saveState).toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith(chatJid, '리뷰 확인 완료');
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
          `The reviewer approved your work (DONE). Finalize and report the result.\n\nReviewer's final assessment:\n${truncatedReviewerOutput}`,
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
    expect(channel.sendMessage).toHaveBeenCalledWith(chatJid, '최종 정리 완료');
  });

  it('reuses the shared arbiter prompt builder for pending arbiter turns', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

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
      runId: 'run-arbiter-pending-shared-prompt',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'arbiter 확인 완료',
    );
  });

  it('does not fabricate owner labels from same-service raw bot history in paired turn prompts', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};
    const channel: Channel = {
      ...makeChannel(chatJid),
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
          '<message sender="Shared Bot" time="30 Mar 09:00">reviewer-like reply</message>',
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
      runId: 'run-same-service-raw-history',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
  });

  it('does not fabricate owner labels from same-service raw bot history in arbiter prompts', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const channel: Channel = {
      ...makeChannel(chatJid),
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
          '<message sender="Shared Bot" time="30 Mar 09:00">reviewer-like reply</message>',
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
      runId: 'run-same-service-arbiter-fallback',
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
});
