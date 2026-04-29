import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createPairedTask,
  failPairedTurn,
  markPairedTurnRunning,
} from './db.js';
import { CODEX_MAIN_SERVICE_ID } from './config.js';
import {
  getCodexBadRequestRepeatThreshold,
  notifyOwnerCodexBadRequestObservation,
} from './session-auto-healer.js';
import type { PairedTask } from './types.js';

const BAD_REQUEST_ERROR = '{"detail":"Bad Request"}';
const originalThresholdEnv = process.env.CODEX_BAD_REQUEST_REPEAT_THRESHOLD;

const pairedTurnIdentity = {
  turnId: 'task-1:updated:owner-follow-up',
  taskId: 'task-1',
  taskUpdatedAt: '2026-04-29T01:00:00.000Z',
  intentKind: 'owner-follow-up' as const,
  role: 'owner' as const,
};

function makeTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'task-1',
    chat_jid: 'dc:room',
    group_folder: 'eyejokerdb-9',
    owner_service_id: CODEX_MAIN_SERVICE_ID,
    reviewer_service_id: 'claude',
    title: null,
    source_ref: null,
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 1,
    status: 'active',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-04-29T08:00:00.000Z',
    updated_at: pairedTurnIdentity.taskUpdatedAt,
    ...overrides,
  };
}

function recordOwnerCodexFailure(runId: string): void {
  markPairedTurnRunning({
    turnIdentity: pairedTurnIdentity,
    executorServiceId: CODEX_MAIN_SERVICE_ID,
    executorAgentType: 'codex',
    runId,
  });
  failPairedTurn({
    turnIdentity: pairedTurnIdentity,
    error: BAD_REQUEST_ERROR,
  });
}

describe('session-auto-healer', () => {
  beforeEach(() => {
    _initTestDatabase();
    delete process.env.CODEX_BAD_REQUEST_REPEAT_THRESHOLD;
  });

  afterEach(() => {
    if (originalThresholdEnv === undefined) {
      delete process.env.CODEX_BAD_REQUEST_REPEAT_THRESHOLD;
    } else {
      process.env.CODEX_BAD_REQUEST_REPEAT_THRESHOLD = originalThresholdEnv;
    }
  });

  it('uses a conservative default Bad Request repeat threshold', () => {
    expect(getCodexBadRequestRepeatThreshold()).toBe(3);
  });

  it('supports threshold override for observation tuning', () => {
    process.env.CODEX_BAD_REQUEST_REPEAT_THRESHOLD = '2';

    expect(getCodexBadRequestRepeatThreshold()).toBe(2);
  });

  it('ignores invalid threshold overrides', () => {
    process.env.CODEX_BAD_REQUEST_REPEAT_THRESHOLD = '1';

    expect(getCodexBadRequestRepeatThreshold()).toBe(3);
  });

  it('notifies once when owner Codex reaches the Bad Request observation threshold', async () => {
    createPairedTask(makeTask());
    for (const runId of ['run-1', 'run-2', 'run-3']) {
      recordOwnerCodexFailure(runId);
    }
    const channel = { sendMessage: vi.fn() };

    const notified = await notifyOwnerCodexBadRequestObservation({
      chatJid: 'dc:room',
      runId: 'run-1',
      groupFolder: 'eyejokerdb-9',
      channel,
      outputStatus: 'error',
      visiblePhase: 'silent',
      deliveryRole: 'owner',
      agentType: 'codex',
      pairedTurnIdentity,
      threshold: 3,
    });

    expect(notified).toBe(true);
    expect(channel.sendMessage).toHaveBeenCalledWith(
      'dc:room',
      expect.stringContaining('자동복구는 아직 비활성화'),
    );
    expect(channel.sendMessage).toHaveBeenCalledWith(
      'dc:room',
      expect.stringContaining('task=task-1'),
    );
  });

  it('does not notify when the failure had visible output', async () => {
    const channel = { sendMessage: vi.fn() };

    const notified = await notifyOwnerCodexBadRequestObservation({
      chatJid: 'dc:room',
      runId: 'run-1',
      groupFolder: 'eyejokerdb-9',
      channel,
      outputStatus: 'error',
      visiblePhase: 'progress',
      deliveryRole: 'owner',
      agentType: 'codex',
      pairedTurnIdentity,
      threshold: 3,
    });

    expect(notified).toBe(false);
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('does not notify again after the exact threshold has already passed', async () => {
    createPairedTask(makeTask());
    for (const runId of ['run-1', 'run-2', 'run-3', 'run-4']) {
      recordOwnerCodexFailure(runId);
    }
    const channel = { sendMessage: vi.fn() };

    const notified = await notifyOwnerCodexBadRequestObservation({
      chatJid: 'dc:room',
      runId: 'run-1',
      groupFolder: 'eyejokerdb-9',
      channel,
      outputStatus: 'error',
      visiblePhase: 'silent',
      deliveryRole: 'owner',
      agentType: 'codex',
      pairedTurnIdentity,
      threshold: 3,
    });

    expect(notified).toBe(false);
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });
});
