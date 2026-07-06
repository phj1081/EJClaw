import type { ChildProcess } from 'child_process';

import { logger } from './logger.js';
import type { GroupState } from './group-queue-state.js';

const POST_CLOSE_SIGTERM_DELAY_MS = 60_000;
const POST_CLOSE_SIGKILL_DELAY_MS = 75_000;

export function isProcessAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

export function waitForProcessExit(proc: ChildProcess): Promise<void> {
  if (!isProcessAlive(proc)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const handleExit = () => {
      proc.off('close', handleExit);
      proc.off('exit', handleExit);
      resolve();
    };

    proc.once('close', handleExit);
    proc.once('exit', handleExit);
  });
}

export function clearPostCloseTimers(state: GroupState): void {
  if (state.postCloseTermTimer) {
    clearTimeout(state.postCloseTermTimer);
    state.postCloseTermTimer = null;
  }
  if (state.postCloseKillTimer) {
    clearTimeout(state.postCloseKillTimer);
    state.postCloseKillTimer = null;
  }
}

export function schedulePostCloseTermination(
  groupJid: string,
  state: GroupState,
  runId: string | null,
  reason: string,
): void {
  const proc = state.process;
  if (!proc || !runId || state.runPhase === 'running_task') {
    return;
  }

  const processName = state.processName;
  const isSameActiveProcess = () =>
    state.process === proc &&
    state.currentRunId === runId &&
    isProcessAlive(proc);

  clearPostCloseTimers(state);

  state.postCloseTermTimer = setTimeout(() => {
    state.postCloseTermTimer = null;
    if (!isSameActiveProcess()) {
      return;
    }

    logger.warn(
      {
        groupJid,
        runId,
        processName,
        reason,
        delayMs: POST_CLOSE_SIGTERM_DELAY_MS,
      },
      'Force-terminating lingering agent after stdin close request',
    );

    try {
      proc.kill('SIGTERM');
    } catch (err) {
      logger.warn(
        { groupJid, runId, processName, err },
        'Failed to SIGTERM lingering agent after stdin close request',
      );
    }
  }, POST_CLOSE_SIGTERM_DELAY_MS);

  state.postCloseKillTimer = setTimeout(() => {
    state.postCloseKillTimer = null;
    if (!isSameActiveProcess()) {
      return;
    }

    logger.error(
      {
        groupJid,
        runId,
        processName,
        reason,
        delayMs: POST_CLOSE_SIGKILL_DELAY_MS,
      },
      'Force-killing stubborn agent after stdin close request',
    );

    try {
      proc.kill('SIGKILL');
    } catch (err) {
      logger.warn(
        { groupJid, runId, processName, err },
        'Failed to SIGKILL stubborn agent after stdin close request',
      );
    }
  }, POST_CLOSE_SIGKILL_DELAY_MS);
}
