import { describe, expect, it } from 'vitest';

import type { StatusSnapshot } from './status-dashboard.js';
import type { PairedTurnAttemptRecord, PairedTurnRecord } from './db.js';
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

  it('builds redacted room activity from messages and paired turn output', () => {
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
        id: 1,
        task_id: task.id,
        turn_number: 1,
        role: 'owner',
        output_text: 'owner output',
        verdict: 'step_done',
        created_at: '2026-04-26T05:25:00.000Z',
      },
      {
        id: 2,
        task_id: task.id,
        turn_number: 2,
        role: 'reviewer',
        output_text: 'reviewer output with BOT_TOKEN=plain-secret-value',
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
        content: 'latest message',
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
          outputText: 'reviewer output with BOT_TOKEN=<redacted>',
        },
      ],
    });
    expect(activity.messages).toMatchObject([
      { senderName: '눈쟁이', content: 'latest message' },
    ]);
  });

  it('builds typed inbox items from pending rooms, paired tasks, and CI failures', () => {
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

    expect(overview.inbox.map((item) => item.kind)).toEqual([
      'ci-failure',
      'approval',
      'reviewer-request',
      'pending-room',
    ]);
    expect(overview.inbox).toContainEqual(
      expect.objectContaining({
        id: 'room:codex-main:dc:ops',
        kind: 'pending-room',
        severity: 'info',
        roomJid: 'dc:ops',
        serviceId: 'codex-main',
        occurredAt: '2026-04-26T05:00:00.000Z',
        createdAt: '2026-04-26T05:10:00.000Z',
      }),
    );
    expect(overview.inbox).toContainEqual(
      expect.objectContaining({
        id: 'paired:review-1:review_ready',
        kind: 'reviewer-request',
        severity: 'warn',
        serviceId: 'claude-reviewer',
        taskStatus: 'review_ready',
        occurredAt: '2026-04-26T05:03:00.000Z',
      }),
    );
    const ciFailure = overview.inbox.find((item) => item.kind === 'ci-failure');
    expect(ciFailure).toMatchObject({
      id: 'ci:ci-2',
      severity: 'error',
      occurrences: 2,
      source: 'scheduled-task',
      taskId: 'ci-2',
      lastOccurredAt: '2026-04-26T05:07:00.000Z',
    });
    expect(ciFailure?.summary).toContain('BOT_TOKEN=<redacted>');
    expect(ciFailure?.summary).not.toContain('plain-secret-value');
    expect(overview.inbox.some((item) => item.taskId === 'cron-1')).toBe(false);
    expect(overview.inbox.some((item) => item.taskId === 'done-1')).toBe(false);
  });
});
