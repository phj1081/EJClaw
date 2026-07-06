import type { ChildProcess } from 'child_process';

import {
  clearPostCloseTimers,
  isProcessAlive,
  waitForProcessExit,
} from './group-queue-process.js';
import { logger } from './logger.js';
import type { GroupState } from './group-queue-state.js';

export async function shutdownGroupProcesses(
  groups: Map<string, GroupState>,
  activeCount: number,
  gracePeriodMs: number,
  closeStdin: (
    groupJid: string,
    metadata?: { runId?: string; reason?: string },
  ) => void,
): Promise<void> {
  const activeProcesses: Array<{
    groupJid: string;
    process: ChildProcess;
    processName: string;
  }> = [];

  for (const [groupJid, state] of groups) {
    clearPostCloseTimers(state);
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryScheduledAt = null;

    if (state.process && state.processName) {
      activeProcesses.push({
        groupJid,
        process: state.process,
        processName: state.processName,
      });

      if (state.runPhase === 'running_messages' && state.ipcDir) {
        closeStdin(groupJid, { reason: 'shutdown' });
      }
    }
  }

  if (activeProcesses.length === 0) {
    logger.info('GroupQueue shutdown with no active agent processes');
    return;
  }

  logger.info(
    {
      activeCount,
      processNames: activeProcesses.map(({ processName }) => processName),
      gracePeriodMs,
    },
    'GroupQueue shutting down, waiting for active agent processes to exit',
  );

  const graceWaitMs = Math.max(gracePeriodMs, 0);
  if (graceWaitMs > 0) {
    await Promise.race([
      Promise.all(
        activeProcesses.map(({ process }) => waitForProcessExit(process)),
      ),
      new Promise((resolve) => setTimeout(resolve, graceWaitMs)),
    ]);
  }

  const stillRunning = activeProcesses.filter(({ process }) =>
    isProcessAlive(process),
  );

  if (stillRunning.length === 0) {
    logger.info('All active agent processes exited during shutdown');
    return;
  }

  logger.warn(
    {
      processNames: stillRunning.map(({ processName }) => processName),
    },
    'Terminating lingering agent processes during shutdown',
  );

  for (const { process } of stillRunning) {
    try {
      process.kill('SIGTERM');
    } catch (err) {
      logger.warn({ err }, 'Failed to SIGTERM lingering agent process');
    }
  }

  await Promise.race([
    Promise.all(stillRunning.map(({ process }) => waitForProcessExit(process))),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);

  const stubborn = stillRunning.filter(({ process }) =>
    isProcessAlive(process),
  );

  if (stubborn.length === 0) {
    return;
  }

  logger.error(
    {
      processNames: stubborn.map(({ processName }) => processName),
    },
    'Force-killing stubborn agent processes during shutdown',
  );

  for (const { process } of stubborn) {
    try {
      process.kill('SIGKILL');
    } catch (err) {
      logger.warn({ err }, 'Failed to SIGKILL stubborn agent process');
    }
  }
}
