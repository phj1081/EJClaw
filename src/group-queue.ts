import { ChildProcess } from 'child_process';

import {
  MAX_CONCURRENT_AGENTS,
  RECOVERY_CONCURRENT_AGENTS,
  RECOVERY_DURATION_MS,
} from './config.js';
import { queueFollowUpMessage, writeCloseSentinel } from './group-queue-ipc.js';
import {
  assertRunPhaseInvariants,
  createGroupState,
  recordRecentDirectTerminalDelivery,
  resetRunState,
  transitionRunPhase,
} from './group-queue-state.js';
import { logger } from './logger.js';
import type {
  GroupRunContext,
  GroupState,
  QueuedTask,
} from './group-queue-state.js';

export type { GroupRunContext } from './group-queue-state.js';

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
const MAX_CONCURRENT_TASKS =
  MAX_CONCURRENT_AGENTS > 1 ? MAX_CONCURRENT_AGENTS - 1 : 1;
const POST_CLOSE_SIGTERM_DELAY_MS = 60_000;
const POST_CLOSE_SIGKILL_DELAY_MS = 75_000;

export interface GroupStatus {
  jid: string;
  status: 'processing' | 'waiting' | 'inactive';
  runPhase: string;
  elapsedMs: number | null;
  pendingMessages: boolean;
  pendingTasks: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private activeTaskCount = 0;
  private waitingGroups: string[] = [];
  private recoveryMode = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private processMessagesFn:
    | ((groupJid: string, context: GroupRunContext) => Promise<boolean>)
    | null = null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = createGroupState();
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(
    fn: (groupJid: string, context: GroupRunContext) => Promise<boolean>,
  ): void {
    this.processMessagesFn = fn;
  }

  /** Limit concurrency after restart to avoid API rate-limit storms. */
  enterRecoveryMode(): void {
    this.recoveryMode = true;
    logger.info(
      {
        maxConcurrent: RECOVERY_CONCURRENT_AGENTS,
        durationMs: RECOVERY_DURATION_MS,
      },
      'Entering recovery mode (staggered restart)',
    );
    this.recoveryTimer = setTimeout(() => {
      this.recoveryMode = false;
      this.recoveryTimer = null;
      logger.info(
        { maxConcurrent: MAX_CONCURRENT_AGENTS },
        'Recovery mode ended, full concurrency restored',
      );
      this.drainWaiting();
    }, RECOVERY_DURATION_MS);
  }

  private get effectiveMaxConcurrent(): number {
    return this.recoveryMode
      ? RECOVERY_CONCURRENT_AGENTS
      : MAX_CONCURRENT_AGENTS;
  }

  private createRunId(): string {
    return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  enqueueMessageCheck(groupJid: string, ipcDir?: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Pre-set IPC dir so sendMessage can pipe follow-ups while agent process starts
    if (ipcDir && !state.ipcDir) {
      state.ipcDir = ipcDir;
    }

    if (state.runPhase !== 'idle') {
      state.pendingMessages = true;
      logger.debug(
        { groupJid, runPhase: state.runPhase },
        'Agent active, message queued',
      );
      return;
    }

    if (
      state.retryScheduledAt !== null &&
      Date.now() < state.retryScheduledAt
    ) {
      state.pendingMessages = true;
      logger.debug(
        {
          groupJid,
          retryCount: state.retryCount,
          retryScheduledAt: state.retryScheduledAt,
        },
        'Retry backoff active, message queued until retry window opens',
      );
      return;
    }

    if (this.activeCount >= this.effectiveMaxConcurrent) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        {
          groupJid,
          activeCount: this.activeCount,
          max: this.effectiveMaxConcurrent,
        },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.runPhase !== 'idle') {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      logger.debug(
        { groupJid, taskId, runPhase: state.runPhase },
        'Agent active, task queued',
      );
      return;
    }

    if (
      this.activeCount >= this.effectiveMaxConcurrent ||
      this.activeTaskCount >= MAX_CONCURRENT_TASKS
    ) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        {
          groupJid,
          taskId,
          activeCount: this.activeCount,
          activeTaskCount: this.activeTaskCount,
        },
        'At task concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    processName: string,
    ipcDir?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.processName = processName;
    if (ipcDir) state.ipcDir = ipcDir;
    logger.info(
      {
        groupJid,
        runId: state.currentRunId,
        processName,
        ipcDir: state.ipcDir,
        runPhase: state.runPhase,
      },
      'Registered active process for group',
    );
  }

  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (state.runPhase !== 'running_messages' || !state.ipcDir) {
      logger.debug(
        {
          groupJid,
          runId: state.currentRunId,
          runPhase: state.runPhase,
          ipcDir: state.ipcDir,
        },
        'Cannot pipe follow-up message to active agent',
      );
      return false;
    }

    try {
      const filename = queueFollowUpMessage(state.ipcDir, text);
      logger.info(
        {
          groupJid,
          runId: state.currentRunId,
          ipcDir: state.ipcDir,
          textLength: text.length,
          filename,
        },
        'Queued follow-up message for active agent',
      );
      return true;
    } catch (err) {
      logger.warn(
        {
          groupJid,
          runId: state.currentRunId,
          ipcDir: state.ipcDir,
          err,
        },
        'Failed to queue follow-up message for active agent',
      );
      return false;
    }
  }

  noteDirectTerminalDelivery(
    groupJid: string,
    senderRole?: string | null,
    text?: string | null,
  ): void {
    const state = this.getGroup(groupJid);
    if (
      state.runPhase !== 'running_messages' ||
      !state.currentRunId ||
      !senderRole ||
      !text ||
      text.length === 0
    ) {
      return;
    }
    state.directTerminalDeliveries.set(senderRole, text);
    recordRecentDirectTerminalDelivery(
      state,
      state.currentRunId,
      senderRole,
      text,
    );
    logger.info(
      {
        groupJid,
        runId: state.currentRunId,
        senderRole,
        textLength: text.length,
      },
      'Recorded direct terminal delivery for active run',
    );
  }

  hasDirectTerminalDeliveryForRun(
    groupJid: string,
    runId: string,
    senderRole?: string | null,
  ): boolean {
    const state = this.getGroup(groupJid);
    if (state.currentRunId !== runId || !senderRole) {
      return false;
    }
    return state.directTerminalDeliveries.has(senderRole);
  }

  getDirectTerminalDeliveryForRun(
    groupJid: string,
    runId: string,
    senderRole?: string | null,
  ): string | null {
    const state = this.getGroup(groupJid);
    if (state.currentRunId !== runId || !senderRole) {
      return null;
    }
    return state.directTerminalDeliveries.get(senderRole) ?? null;
  }

  hasRecordedDirectTerminalDeliveryForRun(
    groupJid: string,
    runId: string,
    senderRole?: string | null,
  ): boolean {
    const state = this.getGroup(groupJid);
    if (!senderRole) {
      return false;
    }
    if (
      state.currentRunId === runId &&
      state.directTerminalDeliveries.has(senderRole)
    ) {
      return true;
    }
    return (
      state.recentDirectTerminalDeliveries.get(runId)?.has(senderRole) ?? false
    );
  }

  private clearPostCloseTimers(state: GroupState): void {
    if (state.postCloseTermTimer) {
      clearTimeout(state.postCloseTermTimer);
      state.postCloseTermTimer = null;
    }
    if (state.postCloseKillTimer) {
      clearTimeout(state.postCloseKillTimer);
      state.postCloseKillTimer = null;
    }
  }

  private schedulePostCloseTermination(
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
      this.isProcessAlive(proc);

    this.clearPostCloseTimers(state);

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

  /**
   * Signal the active agent process to wind down by writing a close sentinel.
   */
  closeStdin(
    groupJid: string,
    metadata?: { runId?: string; reason?: string },
  ): void {
    const state = this.getGroup(groupJid);
    if (state.runPhase === 'idle' || !state.ipcDir) return;
    if (state.runPhase === 'running_messages') {
      transitionRunPhase(state, groupJid, 'closing_messages', {
        reason: metadata?.reason,
        runId: metadata?.runId ?? state.currentRunId,
      });
      assertRunPhaseInvariants(state, groupJid);
    }

    try {
      writeCloseSentinel(state.ipcDir);
      logger.info(
        {
          groupJid,
          runId: metadata?.runId ?? state.currentRunId,
          ipcDir: state.ipcDir,
          reason: metadata?.reason ?? 'unspecified',
        },
        'Signaled active agent to close stdin',
      );
    } catch (err) {
      logger.warn(
        {
          groupJid,
          runId: metadata?.runId ?? state.currentRunId,
          ipcDir: state.ipcDir,
          reason: metadata?.reason ?? 'unspecified',
          err,
        },
        'Failed to signal active agent to close stdin',
      );
    }

    if (metadata?.reason === 'output-delivered-close') {
      this.schedulePostCloseTermination(
        groupJid,
        state,
        metadata.runId ?? state.currentRunId,
        metadata.reason,
      );
    }
  }

  /**
   * Immediately kill the running agent process for a group.
   * Returns true if a process was killed, false if nothing was running.
   */
  killProcess(groupJid: string): boolean {
    const state = this.getGroup(groupJid);
    const proc = state.process;
    if (!proc || !this.isProcessAlive(proc)) {
      return false;
    }
    logger.info(
      {
        groupJid,
        runId: state.currentRunId,
        processName: state.processName,
      },
      'Killing agent process via /stop command',
    );
    try {
      // SIGTERM allows the runner to call AbortController.abort() for graceful cleanup.
      // Falls back to SIGKILL after 5 seconds if the process doesn't exit.
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (this.isProcessAlive(proc)) {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }
      }, 5000);
    } catch {
      /* already dead */
    }
    return true;
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    const runId = this.createRunId();
    state.currentRunId = runId;
    state.pendingMessages = false;
    state.startedAt = Date.now();
    transitionRunPhase(state, groupJid, 'running_messages', { runId, reason });
    assertRunPhaseInvariants(state, groupJid);
    this.activeCount++;

    logger.info(
      {
        groupJid,
        runId,
        reason,
        runPhase: state.runPhase,
        activeCount: this.activeCount,
      },
      'Starting group message run',
    );

    let outcome: 'success' | 'retry_scheduled' | 'error' = 'success';
    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid, {
          runId,
          reason,
        });
        if (success) {
          state.retryCount = 0;
          state.retryScheduledAt = null;
        } else {
          outcome = 'retry_scheduled';
          this.scheduleRetry(groupJid, state, runId);
        }
      }
    } catch (err) {
      outcome = 'error';
      logger.error(
        { groupJid, runId, err },
        'Error processing messages for group',
      );
      this.scheduleRetry(groupJid, state, runId);
    } finally {
      this.clearPostCloseTimers(state);
      const durationMs = state.startedAt ? Date.now() - state.startedAt : null;
      logger.info(
        {
          groupJid,
          runId,
          reason,
          outcome,
          durationMs,
          pendingMessages: state.pendingMessages,
          pendingTasks: state.pendingTasks.length,
        },
        'Finished group message run',
      );
      resetRunState(state, groupJid);
      assertRunPhaseInvariants(state, groupJid);
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.runningTaskId = task.id;
    state.startedAt = Date.now();
    transitionRunPhase(state, groupJid, 'running_task', { taskId: task.id });
    assertRunPhaseInvariants(state, groupJid);
    this.activeCount++;
    this.activeTaskCount++;

    logger.info(
      {
        groupJid,
        taskId: task.id,
        runPhase: state.runPhase,
        activeCount: this.activeCount,
        activeTaskCount: this.activeTaskCount,
      },
      'Running queued task',
    );

    let outcome: 'success' | 'error' = 'success';
    try {
      await task.fn();
    } catch (err) {
      outcome = 'error';
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      this.clearPostCloseTimers(state);
      const durationMs = state.startedAt ? Date.now() - state.startedAt : null;
      logger.info(
        {
          groupJid,
          taskId: task.id,
          outcome,
          durationMs,
          pendingMessages: state.pendingMessages,
          pendingTasks: state.pendingTasks.length,
        },
        'Finished queued task',
      );
      resetRunState(state, groupJid);
      assertRunPhaseInvariants(state, groupJid);
      this.activeCount--;
      this.activeTaskCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(
    groupJid: string,
    state: GroupState,
    runId?: string,
  ): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      if (state.retryTimer) {
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
      }
      state.retryScheduledAt = null;
      logger.error(
        { groupJid, runId, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    state.retryScheduledAt = Date.now() + delayMs;
    logger.info(
      { groupJid, runId, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
    }
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      state.retryScheduledAt = null;
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < this.effectiveMaxConcurrent
    ) {
      const nextMessageIndex = this.waitingGroups.findIndex((jid) => {
        const state = this.getGroup(jid);
        return state.pendingMessages;
      });
      const nextIndex =
        nextMessageIndex !== -1
          ? nextMessageIndex
          : this.waitingGroups.findIndex((jid) => {
              const state = this.getGroup(jid);
              return (
                state.pendingTasks.length > 0 &&
                this.activeTaskCount < MAX_CONCURRENT_TASKS
              );
            });

      if (nextIndex === -1) {
        return;
      }

      const [nextJid] = this.waitingGroups.splice(nextIndex, 1);
      const state = this.getGroup(nextJid);

      if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      } else if (
        state.pendingTasks.length > 0 &&
        this.activeTaskCount < MAX_CONCURRENT_TASKS
      ) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  /**
   * Return current status of all known groups.
   * Only includes groups that have been seen (registered or had activity).
   */
  getStatuses(registeredJids?: string[]): GroupStatus[] {
    const jids = registeredJids ?? [...this.groups.keys()];
    const now = Date.now();
    return jids.map((jid) => {
      const state = this.groups.get(jid);
      if (!state) {
        return {
          jid,
          status: 'inactive' as const,
          runPhase: 'idle',
          elapsedMs: null,
          pendingMessages: false,
          pendingTasks: 0,
        };
      }
      let status: GroupStatus['status'];
      if (state.runPhase !== 'idle') {
        status = 'processing';
      } else if (
        state.pendingMessages ||
        state.pendingTasks.length > 0 ||
        this.waitingGroups.includes(jid)
      ) {
        status = 'waiting';
      } else {
        status = 'inactive';
      }
      return {
        jid,
        status,
        runPhase: state.runPhase,
        elapsedMs: state.startedAt ? now - state.startedAt : null,
        pendingMessages: state.pendingMessages,
        pendingTasks: state.pendingTasks.length,
      };
    });
  }

  private isProcessAlive(proc: ChildProcess): boolean {
    return proc.exitCode === null && proc.signalCode === null;
  }

  private waitForProcessExit(proc: ChildProcess): Promise<void> {
    if (!this.isProcessAlive(proc)) {
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

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const activeProcesses: Array<{
      groupJid: string;
      process: ChildProcess;
      processName: string;
    }> = [];

    for (const [groupJid, state] of this.groups) {
      this.clearPostCloseTimers(state);
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
          this.closeStdin(groupJid, { reason: 'shutdown' });
        }
      }
    }

    if (activeProcesses.length === 0) {
      logger.info('GroupQueue shutdown with no active agent processes');
      return;
    }

    logger.info(
      {
        activeCount: this.activeCount,
        processNames: activeProcesses.map(({ processName }) => processName),
        gracePeriodMs,
      },
      'GroupQueue shutting down, waiting for active agent processes to exit',
    );

    const graceWaitMs = Math.max(gracePeriodMs, 0);
    if (graceWaitMs > 0) {
      await Promise.race([
        Promise.all(
          activeProcesses.map(({ process }) =>
            this.waitForProcessExit(process),
          ),
        ),
        new Promise((resolve) => setTimeout(resolve, graceWaitMs)),
      ]);
    }

    const stillRunning = activeProcesses.filter(({ process }) =>
      this.isProcessAlive(process),
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
      Promise.all(
        stillRunning.map(({ process }) => this.waitForProcessExit(process)),
      ),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);

    const stubborn = stillRunning.filter(({ process }) =>
      this.isProcessAlive(process),
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
}
