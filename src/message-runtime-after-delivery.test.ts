import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  getLatestOpenPairedTaskForChat: vi.fn(),
  hasActiveCiWatcherForChat: vi.fn(() => false),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
  },
}));

vi.mock('./message-runtime-follow-up.js', () => ({
  enqueuePairedFollowUpAfterEvent: vi.fn(),
}));

import {
  getLatestOpenPairedTaskForChat,
  hasActiveCiWatcherForChat,
} from './db.js';
import { logger } from './logger.js';
import { handleMessageRuntimeAfterDeliverySuccess } from './message-runtime-after-delivery.js';
import { enqueuePairedFollowUpAfterEvent } from './message-runtime-follow-up.js';
import type { PairedTask } from './types.js';

function makeTask(overrides: Partial<PairedTask> = {}): PairedTask {
  return {
    id: 'task-1',
    chat_jid: 'chat-1',
    group_folder: 'room',
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
    created_at: '2026-04-29T01:00:00.000Z',
    updated_at: '2026-04-29T01:00:00.000Z',
    ...overrides,
  };
}

describe('message-runtime-after-delivery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(hasActiveCiWatcherForChat).mockReturnValue(false);
  });

  it('skips non-paired and role-less deliveries without side effects', async () => {
    const enqueueMessageCheck = vi.fn();

    await handleMessageRuntimeAfterDeliverySuccess({
      chatJid: 'chat-1',
      runId: 'run-1',
      deliveryRole: null,
      pairedRoom: true,
      enqueueMessageCheck,
    });
    await handleMessageRuntimeAfterDeliverySuccess({
      chatJid: 'chat-1',
      runId: 'run-2',
      deliveryRole: 'owner',
      pairedRoom: false,
      enqueueMessageCheck,
    });

    expect(getLatestOpenPairedTaskForChat).not.toHaveBeenCalled();
    expect(enqueuePairedFollowUpAfterEvent).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('defers owner follow-up while CI watcher is active after review-ready delivery', async () => {
    const task = makeTask({
      id: 'task-review-ready',
      status: 'review_ready',
    });
    vi.mocked(getLatestOpenPairedTaskForChat).mockReturnValue(task);
    vi.mocked(hasActiveCiWatcherForChat).mockReturnValue(true);
    const enqueueMessageCheck = vi.fn();

    await handleMessageRuntimeAfterDeliverySuccess({
      chatJid: 'chat-1',
      runId: 'run-ci-watcher',
      deliveryRole: 'owner',
      pairedRoom: true,
      enqueueMessageCheck,
    });

    expect(hasActiveCiWatcherForChat).toHaveBeenCalledWith('chat-1');
    expect(enqueuePairedFollowUpAfterEvent).not.toHaveBeenCalled();
    expect(enqueueMessageCheck).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'chat-1',
        runId: 'run-ci-watcher',
        completedRole: 'owner',
        taskId: 'task-review-ready',
        taskStatus: 'review_ready',
      }),
      'Deferred paired follow-up after successful owner delivery because CI watcher is still active',
    );
  });

  it('schedules reviewer/arbiter delivery follow-up through message-check enqueue', async () => {
    const task = makeTask({ id: 'task-active', status: 'active' });
    vi.mocked(getLatestOpenPairedTaskForChat).mockReturnValue(task);
    vi.mocked(enqueuePairedFollowUpAfterEvent).mockImplementation(
      (args: any) => {
        args.enqueueMessageCheck();
        return {
          kind: 'paired-follow-up',
          taskId: 'task-active',
          taskStatus: 'active',
          intentKind: 'owner-follow-up',
          scheduled: true,
        } as any;
      },
    );
    const enqueueMessageCheck = vi.fn();

    await handleMessageRuntimeAfterDeliverySuccess({
      chatJid: 'chat-1',
      runId: 'run-reviewer',
      deliveryRole: 'reviewer',
      pairedRoom: true,
      enqueueMessageCheck,
    });

    expect(enqueuePairedFollowUpAfterEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'chat-1',
        runId: 'run-reviewer',
        task,
        source: 'delivery-success',
        completedRole: 'reviewer',
        fallbackLastTurnOutputRole: 'reviewer',
      }),
    );
    expect(enqueueMessageCheck).toHaveBeenCalledWith('chat-1');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'chat-1',
        runId: 'run-reviewer',
        completedRole: 'reviewer',
        taskId: 'task-active',
        taskStatus: 'active',
        intentKind: 'owner-follow-up',
        scheduled: true,
      }),
      'Queued paired follow-up after successful reviewer/arbiter delivery',
    );
  });

  it('logs duplicate owner follow-up suppression when scheduler returns unscheduled', async () => {
    const task = makeTask({ id: 'task-review-ready', status: 'review_ready' });
    vi.mocked(getLatestOpenPairedTaskForChat).mockReturnValue(task);
    vi.mocked(enqueuePairedFollowUpAfterEvent).mockReturnValue({
      kind: 'paired-follow-up',
      taskId: 'task-review-ready',
      taskStatus: 'review_ready',
      intentKind: 'reviewer-turn',
      scheduled: false,
    } as any);

    await handleMessageRuntimeAfterDeliverySuccess({
      chatJid: 'chat-1',
      runId: 'run-owner-duplicate',
      deliveryRole: 'owner',
      pairedRoom: true,
      enqueueMessageCheck: vi.fn(),
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        completedRole: 'owner',
        taskId: 'task-review-ready',
        taskStatus: 'review_ready',
        intentKind: 'reviewer-turn',
        scheduled: false,
      }),
      'Skipped duplicate paired follow-up after successful owner delivery while task state was unchanged',
    );
  });
});
