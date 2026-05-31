import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  completePairedTurn: vi.fn(),
  failPairedTurn: vi.fn(),
  getLastHumanMessageSender: vi.fn(() => '216851709744513024'),
  getLatestTurnNumber: vi.fn(() => 0),
  getPairedTaskById: vi.fn(),
  insertPairedTurnOutput: vi.fn(),
  refreshPairedTaskExecutionLease: vi.fn(() => true),
  releasePairedTaskExecutionLease: vi.fn(),
}));

vi.mock('./paired-execution-context.js', () => ({
  completePairedExecutionContext: vi.fn(),
}));

vi.mock('./paired-turn-run-ownership.js', () => ({
  resolvePairedTurnRunOwnership: vi.fn(() => ({ state: 'active' })),
}));

vi.mock('./message-runtime-follow-up.js', () => ({
  enqueuePairedFollowUpAfterEvent: vi.fn(),
}));

import type { AgentOutput } from './agent-runner.js';
import * as db from './db.js';
import * as pairedExecutionContextModule from './paired-execution-context.js';
import { createPairedExecutionLifecycle } from './message-agent-executor-paired.js';

const log = {
  info: vi.fn(),
  warn: vi.fn(),
};

describe('createPairedExecutionLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores final output attachments with the paired turn output', () => {
    const lifecycle = createPairedExecutionLifecycle({
      pairedExecutionContext: {
        task: {
          id: 'paired-task-output-attachment',
          chat_jid: 'group@test',
          group_folder: 'test-group',
          owner_service_id: 'codex-main',
          reviewer_service_id: 'claude',
          title: null,
          source_ref: 'HEAD',
          plan_notes: null,
          round_trip_count: 0,
          review_requested_at: null,
          status: 'active',
          arbiter_verdict: null,
          arbiter_requested_at: null,
          completion_reason: null,
          created_at: '2026-04-09T00:00:00.000Z',
          updated_at: '2026-04-09T00:00:00.000Z',
        },
        workspace: null,
        envOverrides: {},
      },
      pairedTurnIdentity: {
        turnId:
          'paired-task-output-attachment:2026-04-09T00:00:00.000Z:owner-turn',
        taskId: 'paired-task-output-attachment',
        taskUpdatedAt: '2026-04-09T00:00:00.000Z',
        intentKind: 'owner-turn',
        role: 'owner',
      },
      completedRole: 'owner',
      chatJid: 'group@test',
      runId: 'run-output-attachment',
      enqueueMessageCheck: vi.fn(),
      log,
    });

    lifecycle.recordFinalOutputBeforeDelivery('TASK_DONE\n새 렌더 첨부', [
      {
        path: '/tmp/settings-v0.1.92-deployed-390.png',
        name: 'settings-v0.1.92-deployed-390.png',
        mime: 'image/png',
      },
    ]);

    expect(db.insertPairedTurnOutput).toHaveBeenCalledWith(
      'paired-task-output-attachment',
      1,
      'owner',
      'TASK_DONE\n새 렌더 첨부',
      {
        attachments: [
          {
            path: '/tmp/settings-v0.1.92-deployed-390.png',
            name: 'settings-v0.1.92-deployed-390.png',
            mime: 'image/png',
          },
        ],
      },
    );
  });

  it('does not emit a second public notification after arbiter ESCALATE', async () => {
    const outputs: AgentOutput[] = [];

    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'paired-task-arbiter-escalated',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-04-09T00:00:00.000Z',
      status: 'completed',
      arbiter_verdict: 'escalate',
      arbiter_requested_at: '2026-04-09T00:00:00.000Z',
      completion_reason: 'arbiter_escalated',
      created_at: '2026-04-09T00:00:00.000Z',
      updated_at: '2026-04-09T00:00:01.000Z',
    });

    const lifecycle = createPairedExecutionLifecycle({
      pairedExecutionContext: {
        task: {
          id: 'paired-task-arbiter-escalated',
          chat_jid: 'group@test',
          group_folder: 'test-group',
          owner_service_id: 'claude',
          reviewer_service_id: 'codex-main',
          title: null,
          source_ref: 'HEAD',
          plan_notes: null,
          round_trip_count: 1,
          review_requested_at: '2026-04-09T00:00:00.000Z',
          status: 'in_arbitration',
          arbiter_verdict: null,
          arbiter_requested_at: '2026-04-09T00:00:00.000Z',
          completion_reason: null,
          created_at: '2026-04-09T00:00:00.000Z',
          updated_at: '2026-04-09T00:00:00.000Z',
        },
        workspace: null,
        envOverrides: {},
      },
      pairedTurnIdentity: {
        turnId:
          'paired-task-arbiter-escalated:2026-04-09T00:00:00.000Z:arbiter-turn',
        taskId: 'paired-task-arbiter-escalated',
        taskUpdatedAt: '2026-04-09T00:00:00.000Z',
        intentKind: 'arbiter-turn',
        role: 'arbiter',
      },
      completedRole: 'arbiter',
      chatJid: 'group@test',
      runId: 'run-arbiter-escalated',
      enqueueMessageCheck: vi.fn(),
      onOutput: async (output) => {
        outputs.push(output);
      },
      log,
    });

    lifecycle.recordFinalOutputBeforeDelivery(
      'ESCALATE\nuser decision required',
    );
    lifecycle.markStatus('succeeded');
    lifecycle.markSawOutput(true);
    await lifecycle.asyncFinalize();

    expect(outputs).toEqual([]);
  });

  it('releases an owner turn interrupted by a human message without counting an owner failure', async () => {
    const enqueueMessageCheck = vi.fn();
    vi.mocked(db.getPairedTaskById).mockReturnValue({
      id: 'paired-task-human-interrupted',
      chat_jid: 'group@test',
      group_folder: 'test-group',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      title: null,
      source_ref: 'HEAD',
      plan_notes: null,
      round_trip_count: 1,
      review_requested_at: '2026-04-09T00:00:00.000Z',
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      created_at: '2026-04-09T00:00:00.000Z',
      updated_at: '2026-04-09T00:00:01.000Z',
    });

    const lifecycle = createPairedExecutionLifecycle({
      pairedExecutionContext: {
        task: {
          id: 'paired-task-human-interrupted',
          chat_jid: 'group@test',
          group_folder: 'test-group',
          owner_service_id: 'claude',
          reviewer_service_id: 'codex-main',
          title: null,
          source_ref: 'HEAD',
          plan_notes: null,
          round_trip_count: 1,
          review_requested_at: '2026-04-09T00:00:00.000Z',
          status: 'active',
          arbiter_verdict: null,
          arbiter_requested_at: null,
          completion_reason: null,
          created_at: '2026-04-09T00:00:00.000Z',
          updated_at: '2026-04-09T00:00:00.000Z',
        },
        workspace: null,
        envOverrides: {},
      },
      pairedTurnIdentity: {
        turnId:
          'paired-task-human-interrupted:2026-04-09T00:00:00.000Z:owner-turn',
        taskId: 'paired-task-human-interrupted',
        taskUpdatedAt: '2026-04-09T00:00:00.000Z',
        intentKind: 'owner-turn',
        role: 'owner',
      },
      completedRole: 'owner',
      chatJid: 'group@test',
      runId: 'run-human-interrupted',
      enqueueMessageCheck,
      getCloseReason: () => 'human-message-detected',
      log,
    });

    expect(
      lifecycle.recordFinalOutputBeforeDelivery(
        'TASK_DONE\n부분 진행 결과를 닫기 전에 내보냅니다.',
      ),
    ).toBe(false);
    lifecycle.updateSummary({
      outputText: '아비터 판단을 내리겠습니다.',
    });
    lifecycle.markStatus('succeeded');
    lifecycle.markSawOutput(false);
    await lifecycle.asyncFinalize();

    expect(
      pairedExecutionContextModule.completePairedExecutionContext,
    ).not.toHaveBeenCalled();
    expect(db.insertPairedTurnOutput).not.toHaveBeenCalled();
    expect(db.releasePairedTaskExecutionLease).toHaveBeenCalledWith({
      taskId: 'paired-task-human-interrupted',
      runId: 'run-human-interrupted',
    });
    expect(db.failPairedTurn).toHaveBeenCalledWith({
      turnIdentity: expect.objectContaining({
        taskId: 'paired-task-human-interrupted',
        role: 'owner',
      }),
      error: '아비터 판단을 내리겠습니다.',
    });
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });
});
