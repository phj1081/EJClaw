import { getPairedTurnAttempts } from './db.js';

export interface PairedTurnRunOwnership {
  state: 'active' | 'inactive' | 'missing';
  currentAttemptNo: number | null;
  currentAttemptState: string | null;
  currentAttemptRunId: string | null;
}

export function resolvePairedTurnRunOwnership(args: {
  turnId: string;
  runId: string;
}): PairedTurnRunOwnership {
  const currentAttempt = getPairedTurnAttempts(args.turnId).at(-1);
  if (!currentAttempt) {
    return {
      state: 'missing',
      currentAttemptNo: null,
      currentAttemptState: null,
      currentAttemptRunId: null,
    };
  }

  return {
    state:
      currentAttempt.state === 'running' &&
      currentAttempt.active_run_id === args.runId
        ? 'active'
        : 'inactive',
    currentAttemptNo: currentAttempt.attempt_no,
    currentAttemptState: currentAttempt.state,
    currentAttemptRunId: currentAttempt.active_run_id ?? null,
  };
}
