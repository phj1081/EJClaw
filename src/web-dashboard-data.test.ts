import { describe, expect, it } from 'vitest';

import type { StatusSnapshot } from './status-dashboard.js';
import type {
  PairedTurnAttemptRecord,
  PairedTurnRecord,
  WorkItem,
} from './db.js';
import type {
  NewMessage,
  PairedTask,
  PairedTurnOutput,
  ScheduledTask,
} from './types.js';
import {
  buildWebDashboardRoomActivity,
  buildWebDashboardOverview,
  sanitizeScheduledTask,
} from './web-dashboard-data.js';

function makeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'general',
    chat_jid: 'dc:general',
    agent_type: null,
    status_message_id: null,
    status_started_at: null,
    prompt: 'secret long prompt that should not be exposed in full',
    schedule_type: 'cron',
    schedule_value: '* * * * *',
    context_mode: 'group',
    next_run: '2026-04-26T05:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-04-26T04:00:00.000Z',
    ...overrides,
  };
}

function makePairedTask(overrides: Partial<PairedTask>): PairedTask {
  return {
    id: 'paired-1',
    chat_jid: 'dc:general',
    group_folder: 'general',
    owner_service_id: 'codex-main',
    reviewer_service_id: 'claude-reviewer',
    owner_agent_type: 'codex',
    reviewer_agent_type: 'claude-code',
    arbiter_agent_type: 'codex',
    title: 'Dashboard PR',
    source_ref: null,
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 0,
    owner_failure_count: 0,
    owner_step_done_streak: 0,
    finalize_step_done_count: 0,
    task_done_then_user_reopen_count: 0,
    empty_step_done_streak: 0,
    status: 'review_ready',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-04-26T04:00:00.000Z',
    updated_at: '2026-04-26T04:30:00.000Z',
    ...overrides,
  };
}

function makeDeliveredWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 100,
    group_folder: 'ops',
    chat_jid: 'dc:ops',
    agent_type: 'codex',
    service_id: 'codex-main',
    delivery_role: 'owner',
    status: 'delivered',
    start_seq: null,
    end_seq: null,
    result_payload: 'TASK_DONE\n\ncanonical delivered output',
    attachments: [],
    delivery_attempts: 1,
    delivery_message_id: 'discord-msg-100',
    last_error: null,
    created_at: '2026-04-26T05:30:00.000Z',
    updated_at: '2026-04-26T05:30:10.000Z',
    delivered_at: '2026-04-26T05:30:10.000Z',
    ...overrides,
  };
}

describe('web dashboard data', () => {
  it('builds overview counts from status snapshots and scheduled tasks', () => {
    const snapshots: StatusSnapshot[] = [
      {
        serviceId: 'codex-main',
        agentType: 'codex',
        assistantName: 'Codex',
        updatedAt: '2026-04-26T04:59:00.000Z',
        entries: [
          {
            jid: 'dc:1',
            name: '#general',
            folder: 'general',
            agentType: 'codex',
            status: 'processing',
            elapsedMs: 1200,
            pendingMessages: true,
            pendingTasks: 2,
          },
          {
            jid: 'dc:2',
            name: '#brain',
            folder: 'brain',
            agentType: 'claude-code',
            status: 'inactive',
            elapsedMs: null,
            pendingMessages: false,
            pendingTasks: 0,
          },
        ],
        usageRows: [
          {
            name: 'codex-a',
            h5pct: 10,
            h5reset: '1h',
            d7pct: 20,
            d7reset: '2d',
          },
        ],
      },
    ];

    const overview = buildWebDashboardOverview({
      now: '2026-04-26T05:00:00.000Z',
      snapshots,
      tasks: [
        makeTask({
          id: 'watch-1',
          prompt: '[BACKGROUND CI WATCH] owner/repo#1',
          status: 'active',
        }),
        makeTask({ id: 'cron-1', prompt: 'regular cleanup', status: 'paused' }),
      ],
    });

    expect(overview.rooms.total).toBe(2);
    expect(overview.rooms.active).toBe(1);
    expect(overview.rooms.waiting).toBe(0);
    expect(overview.rooms.inactive).toBe(1);
    expect(overview.tasks.total).toBe(2);
    expect(overview.tasks.active).toBe(1);
    expect(overview.tasks.paused).toBe(1);
    expect(overview.tasks.watchers.active).toBe(1);
    expect(overview.usage.rows).toHaveLength(1);
  });

  it('deduplicates full usage rows from renderer and codex snapshots', () => {
    const snapshots: StatusSnapshot[] = [
      {
        serviceId: 'codex-main',
        agentType: 'codex',
        assistantName: 'Codex',
        updatedAt: '2026-04-26T04:59:00.000Z',
        entries: [],
        usageRowsFetchedAt: '2026-04-26T04:59:00.000Z',
        usageRows: [
          {
            name: 'Codex1',
            h5pct: 20,
            h5reset: '1h',
            d7pct: 30,
            d7reset: '2d',
          },
          {
            name: 'Codex2',
            h5pct: 15,
            h5reset: '1h',
            d7pct: 18,
            d7reset: '2d',
          },
        ],
      },
      {
        serviceId: 'claude-main',
        agentType: 'claude-code',
        assistantName: 'Claude',
        updatedAt: '2026-04-26T05:00:00.000Z',
        entries: [],
        usageRowsFetchedAt: '2026-04-26T05:00:00.000Z',
        usageRows: [
          {
            name: 'Claude1 Max',
            h5pct: 66,
            h5reset: '2h',
            d7pct: 40,
            d7reset: '4d',
          },
          {
            name: 'Kimi',
            h5pct: 10,
            h5reset: '3h',
            d7pct: 12,
            d7reset: '5d',
          },
          {
            name: 'Codex1',
            h5pct: 25,
            h5reset: '55m',
            d7pct: 35,
            d7reset: '2d',
          },
        ],
      },
    ];

    const overview = buildWebDashboardOverview({
      now: '2026-04-26T05:01:00.000Z',
      snapshots,
      tasks: [],
    });

    expect(overview.usage.rows.map((row) => row.name)).toEqual([
      'Claude1 Max',
      'Kimi',
      'Codex1',
      'Codex2',
    ]);
    expect(
      overview.usage.rows.filter((row) => row.name === 'Codex1'),
    ).toHaveLength(1);
    expect(overview.usage.fetchedAt).toBe('2026-04-26T05:00:00.000Z');
  });

  it('does not expose full scheduled task prompts through API payloads', () => {
    const sanitized = sanitizeScheduledTask(
      makeTask({
        prompt: 'x'.repeat(220),
        last_result: 'ok',
      }),
    );

    expect(sanitized).not.toHaveProperty('prompt');
    expect(sanitized.promptPreview.length).toBeLessThanOrEqual(123);
    expect(sanitized.promptLength).toBe(220);
  });

  it('redacts common secret values from scheduled task prompt previews', () => {
    const sanitized = sanitizeScheduledTask(
      makeTask({
        prompt:
          'deploy with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456 and BOT_TOKEN=plain-secret-value',
      }),
    );

    expect(sanitized.promptPreview).toContain('OPENAI_API_KEY=<redacted>');
    expect(sanitized.promptPreview).toContain('BOT_TOKEN=<redacted>');
    expect(sanitized.promptPreview).not.toContain(
      'sk-abcdefghijklmnopqrstuvwxyz123456',
    );
    expect(sanitized.promptPreview).not.toContain('plain-secret-value');
  });
});

describe('web dashboard room activity data', () => {
  it('builds redacted room activity from messages and paired turn output', () => {
    const longMessageTail = 'TAIL_MESSAGE_VISIBLE';
    const longOutputTail = 'TAIL_OUTPUT_VISIBLE';
    const task = makePairedTask({
      id: 'paired-room-1',
      chat_jid: 'dc:ops',
      status: 'in_review',
      round_trip_count: 3,
      updated_at: '2026-04-26T05:30:00.000Z',
    });
    const turn: PairedTurnRecord = {
      turn_id: 'turn-1',
      task_id: task.id,
      task_updated_at: task.updated_at,
      role: 'reviewer',
      intent_kind: 'reviewer-turn',
      state: 'queued',
      executor_service_id: null,
      executor_agent_type: null,
      attempt_no: 0,
      created_at: '2026-04-26T05:19:00.000Z',
      updated_at: '2026-04-26T05:31:00.000Z',
      completed_at: null,
      last_error: null,
    };
    const attempt: PairedTurnAttemptRecord = {
      attempt_id: 'turn-1:attempt:2',
      parent_attempt_id: null,
      parent_handoff_id: null,
      continuation_handoff_id: null,
      turn_id: 'turn-1',
      task_id: task.id,
      task_updated_at: task.updated_at,
      role: 'reviewer',
      intent_kind: 'reviewer-turn',
      state: 'running',
      executor_service_id: 'claude-reviewer',
      executor_agent_type: 'claude-code',
      active_run_id: 'run-reviewer-1',
      attempt_no: 2,
      created_at: '2026-04-26T05:20:00.000Z',
      updated_at: '2026-04-26T05:31:00.000Z',
      completed_at: null,
      last_error: 'OPENAI_API_KEY=plain-secret-value',
    };
    const outputs: PairedTurnOutput[] = [
      {
        id: 2,
        task_id: task.id,
        turn_number: 2,
        role: 'reviewer',
        output_text: `reviewer output with BOT_TOKEN=plain-secret-value ${'x'.repeat(1900)} ${longOutputTail}`,
        verdict: null,
        created_at: '2026-04-26T05:30:00.000Z',
      },
    ];
    const messages: NewMessage[] = [
      {
        id: 'msg-1',
        chat_jid: 'dc:ops',
        sender: 'user-1',
        sender_name: '눈쟁이',
        content: `latest message ${'y'.repeat(950)} ${longMessageTail}`,
        timestamp: '2026-04-26T05:29:00.000Z',
        is_from_me: false,
        is_bot_message: false,
        message_source_kind: 'human',
      },
    ];

    const activity = buildWebDashboardRoomActivity({
      serviceId: 'codex-main',
      entry: {
        jid: 'dc:ops',
        name: '#ops',
        folder: 'ops',
        agentType: 'codex',
        status: 'processing',
        elapsedMs: 15_000,
        pendingMessages: true,
        pendingTasks: 1,
      },
      pairedTask: task,
      turns: [turn],
      attempts: [attempt],
      outputs,
      messages,
      outputLimit: 1,
    });

    expect(activity.pairedTask).toMatchObject({
      id: 'paired-room-1',
      roundTripCount: 3,
      currentTurn: {
        role: 'reviewer',
        state: 'running',
        attemptNo: 2,
        lastError: 'OPENAI_API_KEY=<redacted>',
      },
      outputs: [
        {
          turnNumber: 2,
          role: 'reviewer',
          outputText: expect.stringMatching(
            new RegExp(`BOT_TOKEN=<redacted>[\\s\\S]*${longOutputTail}`),
          ),
        },
      ],
    });
    expect(activity.messages).toMatchObject([
      {
        senderName: '눈쟁이',
        content: expect.stringContaining(longMessageTail),
      },
    ]);
  });

  it('uses delivered work items as the visible outbound source when supplied', () => {
    const task = makePairedTask({
      id: 'paired-canonical-outbound',
      chat_jid: 'dc:ops',
      status: 'in_review',
      updated_at: '2026-04-26T05:30:00.000Z',
    });
    const output: PairedTurnOutput = {
      id: 22,
      task_id: task.id,
      turn_number: 2,
      role: 'owner',
      output_text: 'TASK_DONE\n\nexecution artifact only',
      verdict: 'task_done',
      created_at: '2026-04-26T05:30:00.000Z',
    };

    const activity = buildWebDashboardRoomActivity({
      serviceId: 'codex-main',
      entry: {
        jid: 'dc:ops',
        name: '#ops',
        folder: 'ops',
        agentType: 'codex',
        status: 'inactive',
        elapsedMs: null,
        pendingMessages: false,
        pendingTasks: 0,
      },
      pairedTask: task,
      turns: [],
      attempts: [],
      outputs: [output],
      outboundItems: [makeDeliveredWorkItem()],
      messages: [
        {
          id: 'discord-msg-100',
          chat_jid: 'dc:ops',
          sender: 'bot-owner',
          sender_name: '오너',
          content: 'TASK_DONE\n\ncanonical delivered output',
          timestamp: '2026-04-26T05:30:10.000Z',
          is_from_me: true,
          is_bot_message: true,
          message_source_kind: 'bot',
        },
      ],
    });

    expect(activity.pairedTask?.outputs).toEqual([]);
    expect(activity.messages).toEqual([
      expect.objectContaining({
        id: 'work:100',
        senderName: 'owner',
        content: 'TASK_DONE\n\ncanonical delivered output',
      }),
    ]);
  });

  it('hides legacy delivered work items without discord delivery evidence', () => {
    const activity = buildWebDashboardRoomActivity({
      serviceId: 'codex-main',
      entry: {
        jid: 'dc:ops',
        name: '#ops',
        folder: 'ops',
        agentType: 'codex',
        status: 'inactive',
        elapsedMs: null,
        pendingMessages: false,
        pendingTasks: 0,
      },
      pairedTask: null,
      turns: [],
      attempts: [],
      outputs: [],
      outboundItems: [
        makeDeliveredWorkItem({
          id: 103,
          delivery_role: null,
          delivery_message_id: null,
          result_payload: '서비스 재시작으로 이전 작업이 중단됐습니다.',
        }),
      ],
      messages: [],
    });

    expect(activity.messages).toEqual([]);
  });

  it('keeps legacy delivered work items when a discord echo exists', () => {
    const activity = buildWebDashboardRoomActivity({
      serviceId: 'codex-main',
      entry: {
        jid: 'dc:ops',
        name: '#ops',
        folder: 'ops',
        agentType: 'codex',
        status: 'inactive',
        elapsedMs: null,
        pendingMessages: false,
        pendingTasks: 0,
      },
      pairedTask: null,
      turns: [],
      attempts: [],
      outputs: [],
      outboundItems: [
        makeDeliveredWorkItem({
          id: 104,
          delivery_message_id: null,
          result_payload: 'TASK_DONE\n\nlegacy delivered output',
        }),
      ],
      messages: [
        {
          id: 'discord-legacy-echo',
          chat_jid: 'dc:ops',
          sender: 'bot-owner',
          sender_name: '오너',
          content: 'TASK_DONE\n\nlegacy delivered output',
          timestamp: '2026-04-26T05:30:11.000Z',
          is_from_me: true,
          is_bot_message: true,
          message_source_kind: 'bot',
        },
      ],
    });

    expect(activity.messages).toEqual([
      expect.objectContaining({
        id: 'work:104',
        content: 'TASK_DONE\n\nlegacy delivered output',
      }),
    ]);
  });

  it('merges canonical outbound and recent messages in chronological order', () => {
    const activity = buildWebDashboardRoomActivity({
      serviceId: 'codex-main',
      entry: {
        jid: 'dc:ops',
        name: '#ops',
        folder: 'ops',
        agentType: 'codex',
        status: 'inactive',
        elapsedMs: null,
        pendingMessages: false,
        pendingTasks: 0,
      },
      pairedTask: null,
      turns: [],
      attempts: [],
      outputs: [],
      outboundItems: [
        makeDeliveredWorkItem({
          id: 101,
          delivered_at: '2026-04-26T05:30:00.000Z',
          result_payload: 'owner canonical',
        }),
      ],
      messages: [
        {
          id: 'human-after',
          chat_jid: 'dc:ops',
          sender: 'user-1',
          sender_name: '눈쟁이',
          content: 'human after',
          timestamp: '2026-04-26T05:31:00.000Z',
          is_from_me: false,
          is_bot_message: false,
          message_source_kind: 'human',
        },
      ],
    });

    expect(activity.messages.map((message) => message.id)).toEqual([
      'work:101',
      'human-after',
    ]);
  });

  it('uses canonical turn progress without exposing status messages as recent chat', () => {
    const task = makePairedTask({
      id: 'paired-room-progress',
      chat_jid: 'dc:ops',
      status: 'active',
      updated_at: '2026-04-26T06:10:00.000Z',
    });
    const turn: PairedTurnRecord = {
      turn_id: 'turn-progress',
      task_id: task.id,
      task_updated_at: task.updated_at,
      role: 'owner',
      intent_kind: 'owner-turn',
      state: 'running',
      executor_service_id: 'codex-main',
      executor_agent_type: 'codex',
      attempt_no: 1,
      created_at: '2026-04-26T06:00:00.000Z',
      updated_at: '2026-04-26T06:10:00.000Z',
      completed_at: null,
      last_error: null,
      progress_text: 'building mobile parity',
      progress_updated_at: '2026-04-26T06:07:00.000Z',
    };
    const statusPrefix = '⁣⁣⁣';
    const messages: NewMessage[] = [
      {
        id: 'msg-latest',
        chat_jid: 'dc:ops',
        sender: 'user-1',
        sender_name: '눈쟁이',
        content: 'recent human message',
        timestamp: '2026-04-26T06:09:00.000Z',
        is_from_me: false,
        is_bot_message: false,
        message_source_kind: 'human',
      },
      {
        id: 'msg-status-progress',
        chat_jid: 'dc:ops',
        sender: 'bot-1',
        sender_name: '오너',
        content: `${statusPrefix}status noise that belongs to display only\n\n12s`,
        timestamp: '2026-04-26T06:08:00.000Z',
        is_from_me: true,
        is_bot_message: true,
        message_source_kind: 'bot',
      },
    ];

    const activity = buildWebDashboardRoomActivity({
      serviceId: 'codex-main',
      entry: {
        jid: 'dc:ops',
        name: '#ops',
        folder: 'ops',
        agentType: 'codex',
        status: 'processing',
        elapsedMs: 20_000,
        pendingMessages: false,
        pendingTasks: 0,
      },
      pairedTask: task,
      turns: [turn],
      attempts: [],
      outputs: [],
      messages,
    });

    expect(activity.pairedTask?.currentTurn).toMatchObject({
      progressText: 'building mobile parity',
      progressUpdatedAt: '2026-04-26T06:07:00.000Z',
    });
    expect(activity.messages).toEqual([
      expect.objectContaining({
        senderName: '눈쟁이',
        content: 'recent human message',
      }),
    ]);
  });

  it('keeps a progress-updated turn current when a newer empty reservation exists', () => {
    const task = makePairedTask({
      id: 'paired-room-progress-race',
      chat_jid: 'dc:ops',
      status: 'active',
      updated_at: '2026-04-26T06:10:00.000Z',
    });
    const activeProgressTurn: PairedTurnRecord = {
      turn_id: 'turn-progress-active',
      task_id: task.id,
      task_updated_at: task.updated_at,
      role: 'owner',
      intent_kind: 'owner-follow-up',
      state: 'running',
      executor_service_id: 'codex-main',
      executor_agent_type: 'codex',
      attempt_no: 1,
      created_at: '2026-04-26T06:00:00.000Z',
      updated_at: '2026-04-26T06:10:00.000Z',
      completed_at: null,
      last_error: null,
      progress_text: 'checking dashboard parity',
      progress_updated_at: '2026-04-26T06:12:00.000Z',
    };
    const queuedEmptyTurn: PairedTurnRecord = {
      ...activeProgressTurn,
      turn_id: 'turn-queued-empty',
      state: 'queued',
      executor_service_id: null,
      executor_agent_type: null,
      attempt_no: 0,
      created_at: '2026-04-26T06:11:00.000Z',
      updated_at: '2026-04-26T06:11:00.000Z',
      progress_text: null,
      progress_updated_at: null,
    };

    const activity = buildWebDashboardRoomActivity({
      serviceId: 'codex-main',
      entry: {
        jid: 'dc:ops',
        name: '#ops',
        folder: 'ops',
        agentType: 'codex',
        status: 'processing',
        elapsedMs: 20_000,
        pendingMessages: false,
        pendingTasks: 0,
      },
      pairedTask: task,
      turns: [activeProgressTurn, queuedEmptyTurn],
      attempts: [],
      outputs: [],
      messages: [],
    });

    expect(activity.pairedTask?.currentTurn).toMatchObject({
      turnId: 'turn-progress-active',
      progressText: 'checking dashboard parity',
      progressUpdatedAt: '2026-04-26T06:12:00.000Z',
    });
  });

  it('does not show active turn placeholders when canonical progress is absent', () => {
    const task = makePairedTask({
      id: 'paired-progress-internal',
      chat_jid: 'dc:ops',
      status: 'active',
      updated_at: '2026-04-26T06:10:00.000Z',
    });
    const turn: PairedTurnRecord = {
      turn_id: 'turn-progress-internal',
      task_id: task.id,
      task_updated_at: task.updated_at,
      role: 'owner',
      intent_kind: 'owner-turn',
      state: 'running',
      executor_service_id: 'codex-main',
      executor_agent_type: 'codex',
      attempt_no: 1,
      created_at: '2026-04-26T06:00:00.000Z',
      updated_at: '2026-04-26T06:10:00.000Z',
      completed_at: null,
      last_error: null,
      progress_text: null,
      progress_updated_at: null,
    };

    const activity = buildWebDashboardRoomActivity({
      serviceId: 'codex-main',
      entry: {
        jid: 'dc:ops',
        name: '#ops',
        folder: 'ops',
        agentType: 'codex',
        status: 'processing',
        elapsedMs: 20_000,
        pendingMessages: false,
        pendingTasks: 0,
      },
      pairedTask: task,
      turns: [turn],
      attempts: [],
      outputs: [],
      messages: [],
    });

    expect(activity.pairedTask?.currentTurn).toMatchObject({
      progressText: null,
      progressUpdatedAt: null,
    });
  });
});

describe('web dashboard inbox data', () => {
  it('builds user-action inbox items from merge-ready paired tasks only', () => {
    const snapshots: StatusSnapshot[] = [
      {
        serviceId: 'codex-main',
        agentType: 'codex',
        assistantName: 'Codex',
        updatedAt: '2026-04-26T05:00:00.000Z',
        entries: [
          {
            jid: 'dc:ops',
            name: '#ops',
            folder: 'ops',
            agentType: 'codex',
            status: 'waiting',
            elapsedMs: 1000,
            pendingMessages: true,
            pendingTasks: 0,
          },
          {
            jid: 'dc:idle',
            name: '#idle',
            folder: 'idle',
            agentType: 'codex',
            status: 'inactive',
            elapsedMs: null,
            pendingMessages: false,
            pendingTasks: 0,
          },
        ],
      },
    ];

    const overview = buildWebDashboardOverview({
      now: '2026-04-26T05:10:00.000Z',
      snapshots,
      pairedTasks: [
        makePairedTask({
          id: 'review-1',
          status: 'review_ready',
          review_requested_at: '2026-04-26T05:03:00.000Z',
        }),
        makePairedTask({
          chat_jid: 'dc:ops',
          group_folder: 'ops',
          id: 'merge-1',
          status: 'merge_ready',
          title: 'Ready to merge',
          updated_at: '2026-04-26T05:04:00.000Z',
        }),
        makePairedTask({
          id: 'done-1',
          status: 'completed',
        }),
      ],
      tasks: [
        makeTask({
          id: 'ci-1',
          prompt:
            '[BACKGROUND CI WATCH]\nWatch target:\nPR #21\n\nCheck instructions:\nwatch',
          last_run: '2026-04-26T05:05:00.000Z',
          last_result: 'Error: BOT_TOKEN=plain-secret-value failed',
          status: 'paused',
        }),
        makeTask({
          id: 'ci-2',
          prompt:
            '[BACKGROUND CI WATCH]\nWatch target:\nPR #22\n\nCheck instructions:\nwatch',
          last_run: '2026-04-26T05:07:00.000Z',
          last_result: 'Error: BOT_TOKEN=plain-secret-value failed',
          status: 'active',
        }),
        makeTask({
          id: 'cron-1',
          prompt: 'regular cron',
          last_run: '2026-04-26T05:06:00.000Z',
          last_result: 'Error: non-watch task failed',
        }),
      ],
    });

    expect(overview.inbox.map((item) => item.kind)).toEqual(['approval']);
    expect(overview.inbox).toContainEqual(
      expect.objectContaining({
        id: 'paired:merge-1:merge_ready',
        kind: 'approval',
        severity: 'warn',
        roomJid: 'dc:ops',
        taskId: 'merge-1',
        serviceId: 'codex-main',
        occurredAt: '2026-04-26T05:04:00.000Z',
        createdAt: '2026-04-26T05:10:00.000Z',
      }),
    );
    expect(overview.inbox.some((item) => item.kind === 'pending-room')).toBe(
      false,
    );
    expect(
      overview.inbox.some((item) => item.kind === 'reviewer-request'),
    ).toBe(false);
    expect(overview.inbox.some((item) => item.kind === 'arbiter-request')).toBe(
      false,
    );
    expect(overview.inbox.some((item) => item.kind === 'ci-failure')).toBe(
      false,
    );
    expect(overview.inbox.some((item) => item.taskId === 'ci-1')).toBe(false);
    expect(overview.inbox.some((item) => item.taskId === 'ci-2')).toBe(false);
    expect(overview.inbox.some((item) => item.taskId === 'cron-1')).toBe(false);
    expect(overview.inbox.some((item) => item.taskId === 'done-1')).toBe(false);
    expect(overview.tasks.watchers).toEqual({
      active: 1,
      paused: 1,
      completed: 0,
    });
  });
});
