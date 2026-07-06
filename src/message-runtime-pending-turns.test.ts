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

import * as config from './config.js';
import * as db from './db.js';
import {
  buildPendingPairedTurn,
  resolveBotOnlyPairedFollowUpAction,
} from './message-runtime-flow.js';
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

describe('createMessageRuntime reviewer pending turns', () => {
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

  it('does not reinject previous task finals in a new reviewer prompt when the current task has no outputs', () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const currentTask = {
      id: 'task-current-reviewer',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:10.000Z',
      round_trip_count: 1,
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:10.000Z',
      updated_at: '2026-03-30T00:00:10.000Z',
    } as any;
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([]);
    vi.mocked(db.getLastHumanMessageContent).mockReturnValue('추가 질문');

    const pending = buildPendingPairedTurn({
      chatJid,
      timezone: 'UTC',
      task: currentTask,
      rawMissedMessages: [{ seq: 42, timestamp: '2026-03-30T00:00:11.000Z' }],
      recentHumanMessages: [],
      labeledRecentMessages: [],
      resolveChannel: () => makeChannel(chatJid, 'discord-review', false),
    });

    expect(pending).not.toBeNull();
    expect(db.getLatestPreviousPairedTaskForChat).not.toHaveBeenCalled();
    expect(pending?.prompt).toContain('추가 질문');
    expect(pending?.prompt).not.toContain(
      'Background from the previous completed paired task:',
    );
    expect(pending?.prompt).not.toContain('Previous task owner final:');
    expect(pending?.prompt).not.toContain('이전 owner 답변');
    expect(pending?.prompt).not.toContain('Previous task reviewer final:');
    expect(pending?.prompt).not.toContain('이전 reviewer 피드백');
  });
});

describe('createMessageRuntime owner pending turns', () => {
  it('does not build an owner follow-up pending turn from owner STEP_DONE on an active task', () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const task = {
      id: 'task-owner-step-done-pending',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: null,
      round_trip_count: 1,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:10.000Z',
      updated_at: '2026-03-30T00:00:10.000Z',
    } as any;

    vi.mocked(db.getLatestPreviousPairedTaskForChat).mockReturnValue(undefined);
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: task.id,
        turn_number: 1,
        role: 'owner',
        output_text: 'STEP_DONE\n1단계는 끝났고 2단계로 이어가야 함',
        created_at: '2026-03-30T00:00:11.000Z',
      },
    ] as any);

    const pending = buildPendingPairedTurn({
      chatJid,
      timezone: 'UTC',
      task,
      rawMissedMessages: [{ seq: 42, timestamp: '2026-03-30T00:00:12.000Z' }],
      recentHumanMessages: [],
      labeledRecentMessages: [],
      resolveChannel: () => makeChannel(chatJid),
    });

    expect(pending).toBeNull();
  });

  it('builds a reviewer pending turn when a review_ready task follows owner TASK_DONE output', () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const task = {
      id: 'task-owner-task-done-pending',
      chat_jid: chatJid,
      group_folder: group.folder,
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      review_requested_at: '2026-03-30T00:00:10.000Z',
      round_trip_count: 1,
      status: 'review_ready',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-03-30T00:00:10.000Z',
      updated_at: '2026-03-30T00:00:10.000Z',
    } as any;

    vi.mocked(db.getLatestPreviousPairedTaskForChat).mockReturnValue(undefined);
    vi.mocked(db.getPairedTurnOutputs).mockReturnValue([
      {
        id: 1,
        task_id: task.id,
        turn_number: 1,
        role: 'owner',
        output_text: 'TASK_DONE\n요청 범위 전체 완료',
        created_at: '2026-03-30T00:00:11.000Z',
      },
    ] as any);

    const pending = buildPendingPairedTurn({
      chatJid,
      timezone: 'UTC',
      task,
      rawMissedMessages: [{ seq: 42, timestamp: '2026-03-30T00:00:12.000Z' }],
      recentHumanMessages: [],
      labeledRecentMessages: [],
      resolveChannel: () => makeChannel(chatJid, 'discord-review', false),
    });

    expect(pending).not.toBeNull();
    expect(pending).toMatchObject({
      role: 'reviewer',
      intentKind: 'reviewer-turn',
      taskId: task.id,
    });
  });
});
