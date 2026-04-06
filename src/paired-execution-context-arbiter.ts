import { ARBITER_DEADLOCK_THRESHOLD } from './config.js';
import { updatePairedTask } from './db.js';
import { logger } from './logger.js';
import { classifyArbiterVerdict } from './paired-execution-context-shared.js';
import type { PairedTask } from './types.js';

export function handleFailedArbiterExecution(args: {
  task: PairedTask;
  taskId: string;
}): void {
  const { task, taskId } = args;
  const now = new Date().toISOString();
  const fallbackStatus =
    task.status === 'in_arbitration' || task.status === 'arbiter_requested'
      ? 'arbiter_requested'
      : task.status;
  if (fallbackStatus !== task.status) {
    updatePairedTask(taskId, { status: fallbackStatus, updated_at: now });
    logger.warn(
      {
        taskId,
        role: 'arbiter',
        previousStatus: task.status,
        nextStatus: fallbackStatus,
      },
      'Preserved arbiter task in arbitration-requested state after failed execution',
    );
  }
}

export function handleArbiterCompletion(args: {
  taskId: string;
  summary?: string | null;
}): void {
  const { taskId, summary } = args;
  const now = new Date().toISOString();
  const arbiterVerdict = classifyArbiterVerdict(summary);

  logger.info(
    { taskId, arbiterVerdict, summary: summary?.slice(0, 200) },
    'Arbiter verdict rendered',
  );

  switch (arbiterVerdict) {
    case 'proceed':
    case 'revise':
    case 'reset':
      updatePairedTask(taskId, {
        status: 'active',
        round_trip_count: Math.max(0, ARBITER_DEADLOCK_THRESHOLD - 1),
        arbiter_verdict: arbiterVerdict,
        updated_at: now,
      });
      logger.info(
        { taskId, arbiterVerdict },
        'Arbiter resolved deadlock — resuming ping-pong',
      );
      return;
    case 'escalate':
      updatePairedTask(taskId, {
        status: 'completed',
        arbiter_verdict: 'escalate',
        completion_reason: 'arbiter_escalated',
        updated_at: now,
      });
      logger.info({ taskId }, 'Arbiter escalated to user — task completed');
      return;
    default:
      updatePairedTask(taskId, {
        status: 'active',
        round_trip_count: Math.max(0, ARBITER_DEADLOCK_THRESHOLD - 1),
        arbiter_verdict: 'unknown',
        updated_at: now,
      });
      logger.warn(
        { taskId, summary: summary?.slice(0, 200) },
        'Arbiter verdict unrecognized — falling back to proceed',
      );
      return;
  }
}
