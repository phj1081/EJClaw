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

describe('createMessageRuntime review prompt injection guards', () => {
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
      runId: 'run-review-prompt-sanitized',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(lastAgentTimestamps[`${chatJid}:reviewer`]).toBe('41');
    expect(saveState).toHaveBeenCalled();
    expect(db.createProducedWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_role: 'reviewer',
        service_id: 'codex-main',
      }),
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
    const lastAgentTimestamps: Record<string, string> = {};

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
});

describe('createMessageRuntime final delivery suppression guards', () => {
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
      runId: 'run-review-streamed-terminal',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(noteDirectTerminalDelivery).not.toHaveBeenCalled();
    expect(db.createProducedWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_role: 'reviewer',
        service_id: 'codex-main',
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
});

describe('createMessageRuntime finalize prompts', () => {
  it('uses a compact finalize prompt without reinjecting reviewer output', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const longReviewerOutput = `검토 요약 ${'a'.repeat(2105)} 끝`;

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
          'The reviewer approved the current task scope (TASK_DONE / legacy DONE). Finalize and report the result.\n' +
            'If you intend to close this paired turn now, your first line must be TASK_DONE.\n' +
            'Do not use STEP_DONE only because a broader roadmap still has remaining work; close the approved slice and continue the next slice in a new owner turn.\n' +
            'Use STEP_DONE only when this same approved scope still needs additional owner changes and another review pass.\n' +
            'If your first line is DONE_WITH_CONCERNS, the system will reopen review instead of finishing.',
        );
        expect(input.prompt).not.toContain("Reviewer's final assessment:");
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
      runId: 'run-merge-ready-finalize-summary',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(db.createProducedWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_role: 'owner',
        service_id: 'claude',
      }),
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
          'The reviewer approved the current task scope (TASK_DONE / legacy DONE). Finalize and report the result.\nIf you intend to close this paired turn now, your first line must be TASK_DONE.\nDo not use STEP_DONE only because a broader roadmap still has remaining work; close the approved slice and continue the next slice in a new owner turn.\nUse STEP_DONE only when this same approved scope still needs additional owner changes and another review pass.\nIf your first line is DONE_WITH_CONCERNS, the system will reopen review instead of finishing.',
        );
        expect(input.prompt).not.toContain('리뷰 승인 요약');
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
      runId: 'run-merge-ready-bot-follow-up',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith(chatJid, '최종 정리 완료');
    expect(lastAgentTimestamps[chatJid]).toBe('42');
    expect(saveState).toHaveBeenCalled();
  });
});
