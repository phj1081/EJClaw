import type { ChildProcess } from 'child_process';

import { logger } from './logger.js';

export interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

export interface GroupRunContext {
  runId: string;
  reason: 'messages' | 'drain';
}

export type RunPhase =
  | 'idle'
  | 'running_messages'
  | 'running_task'
  | 'closing_messages';

const VALID_TRANSITIONS: Record<RunPhase, readonly RunPhase[]> = {
  idle: ['running_messages', 'running_task'],
  running_messages: ['closing_messages', 'idle'],
  closing_messages: ['idle'],
  running_task: ['idle'],
};

export interface GroupState {
  runPhase: RunPhase;
  runningTaskId: string | null;
  currentRunId: string | null;
  directTerminalDeliveries: Map<string, string>;
  recentDirectTerminalDeliveries: Map<string, Map<string, string>>;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  processName: string | null;
  ipcDir: string | null;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryScheduledAt: number | null;
  postCloseTermTimer: ReturnType<typeof setTimeout> | null;
  postCloseKillTimer: ReturnType<typeof setTimeout> | null;
  startedAt: number | null;
}

const MAX_RECORDED_DIRECT_TERMINAL_RUNS = 16;

export function createGroupState(): GroupState {
  return {
    runPhase: 'idle',
    runningTaskId: null,
    currentRunId: null,
    directTerminalDeliveries: new Map(),
    recentDirectTerminalDeliveries: new Map(),
    pendingMessages: false,
    pendingTasks: [],
    process: null,
    processName: null,
    ipcDir: null,
    retryCount: 0,
    retryTimer: null,
    retryScheduledAt: null,
    postCloseTermTimer: null,
    postCloseKillTimer: null,
    startedAt: null,
  };
}

export function recordRecentDirectTerminalDelivery(
  state: GroupState,
  runId: string,
  senderRole: string,
  text: string,
): void {
  const existing = state.recentDirectTerminalDeliveries.get(runId) ?? new Map();
  existing.set(senderRole, text);
  state.recentDirectTerminalDeliveries.delete(runId);
  state.recentDirectTerminalDeliveries.set(runId, existing);

  while (
    state.recentDirectTerminalDeliveries.size >
    MAX_RECORDED_DIRECT_TERMINAL_RUNS
  ) {
    const oldestRunId =
      state.recentDirectTerminalDeliveries.keys().next().value ?? null;
    if (!oldestRunId) {
      break;
    }
    state.recentDirectTerminalDeliveries.delete(oldestRunId);
  }
}

export function transitionRunPhase(
  state: GroupState,
  groupJid: string,
  nextPhase: RunPhase,
  metadata?: {
    reason?: string;
    runId?: string | null;
    taskId?: string | null;
  },
): void {
  const fromPhase = state.runPhase;
  if (fromPhase === nextPhase) return;

  const validNextPhases = VALID_TRANSITIONS[fromPhase];
  if (!validNextPhases.includes(nextPhase)) {
    logger.error(
      {
        groupJid,
        fromPhase,
        toPhase: nextPhase,
        validNextPhases,
        reason: metadata?.reason,
        runId: metadata?.runId,
        taskId: metadata?.taskId,
      },
      'Invalid group run phase transition',
    );
  }

  state.runPhase = nextPhase;
  logger.info(
    {
      groupJid,
      fromPhase,
      toPhase: nextPhase,
      transition: `${fromPhase} → ${nextPhase}`,
      reason: metadata?.reason,
      runId: metadata?.runId,
      taskId: metadata?.taskId,
    },
    'Group run phase changed',
  );
}

export function resetRunState(state: GroupState, groupJid: string): void {
  state.currentRunId = null;
  state.runningTaskId = null;
  state.startedAt = null;
  state.process = null;
  state.processName = null;
  state.ipcDir = null;
  state.directTerminalDeliveries.clear();
  transitionRunPhase(state, groupJid, 'idle');
}

export function assertRunPhaseInvariants(
  state: GroupState,
  groupJid: string,
): void {
  switch (state.runPhase) {
    case 'idle':
      if (
        state.currentRunId != null ||
        state.runningTaskId != null ||
        state.process != null ||
        state.processName != null
      ) {
        logger.error(
          {
            groupJid,
            runPhase: state.runPhase,
            currentRunId: state.currentRunId,
            runningTaskId: state.runningTaskId,
            hasProcess: state.process != null,
            processName: state.processName,
          },
          'Invariant violation: idle phase has stale run/task ID or process',
        );
      }
      break;
    case 'running_messages':
    case 'closing_messages':
      if (state.currentRunId == null || state.runningTaskId != null) {
        logger.error(
          {
            groupJid,
            runPhase: state.runPhase,
            currentRunId: state.currentRunId,
            runningTaskId: state.runningTaskId,
          },
          'Invariant violation: messages phase has missing runId or stale taskId',
        );
      }
      break;
    case 'running_task':
      if (state.runningTaskId == null || state.currentRunId != null) {
        logger.error(
          {
            groupJid,
            runPhase: state.runPhase,
            runningTaskId: state.runningTaskId,
            currentRunId: state.currentRunId,
          },
          'Invariant violation: task phase has no taskId or has stale currentRunId',
        );
      }
      break;
  }
}
