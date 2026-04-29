import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getLatestPairedTurnForTask,
  markPairedTurnRunning,
  reservePairedTurnReservation,
  updatePairedTurnProgressText,
} from './db.js';
import { CODEX_MAIN_SERVICE_ID } from './config.js';
import { buildPairedTurnIdentity } from './paired-turn-identity.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('paired turn progress activity', () => {
  it('selects the latest paired turn by progress activity timestamp', async () => {
    const taskId = 'progress-latest-task';
    const activeTurn = buildPairedTurnIdentity({
      taskId,
      taskUpdatedAt: '2026-04-10T00:00:00.000Z',
      intentKind: 'owner-follow-up',
      role: 'owner',
    });
    const queuedTurn = buildPairedTurnIdentity({
      taskId,
      taskUpdatedAt: '2026-04-10T00:01:00.000Z',
      intentKind: 'owner-follow-up',
      role: 'owner',
    });

    markPairedTurnRunning({
      turnIdentity: activeTurn,
      executorServiceId: CODEX_MAIN_SERVICE_ID,
      executorAgentType: 'codex',
      runId: 'run-progress-active',
    });
    expect(
      reservePairedTurnReservation({
        chatJid: 'dc:ops',
        taskId,
        taskStatus: 'active',
        roundTripCount: 1,
        taskUpdatedAt: queuedTurn.taskUpdatedAt,
        intentKind: queuedTurn.intentKind,
        runId: 'run-queued-empty',
      }),
    ).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    updatePairedTurnProgressText(
      activeTurn.turnId,
      'checking dashboard parity',
    );

    expect(getLatestPairedTurnForTask(taskId)).toMatchObject({
      turn_id: activeTurn.turnId,
      progress_text: 'checking dashboard parity',
    });
  });
});
