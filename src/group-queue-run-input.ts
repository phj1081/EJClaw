import { recordRecentDirectTerminalDelivery } from './group-queue-state.js';
import { logger } from './logger.js';
import type { GroupState } from './group-queue-state.js';
import type { NewMessage } from './types.js';

export type ActiveMessageRunInputClaim = {
  runId: string;
  startSeq: number | null;
  endSeq: number | null;
  messageIds?: readonly string[];
};

export function recordActiveMessageRunInput(
  state: GroupState,
  groupJid: string,
  claim: ActiveMessageRunInputClaim,
): boolean {
  if (
    state.currentRunId !== claim.runId ||
    state.runPhase !== 'running_messages'
  ) {
    logger.debug(
      {
        groupJid,
        claimRunId: claim.runId,
        currentRunId: state.currentRunId,
        runPhase: state.runPhase,
      },
      'Ignoring active message input claim because it does not match the current run',
    );
    return false;
  }

  const startSeq = claim.startSeq;
  const endSeq = claim.endSeq;
  state.activeMessageRunInput = {
    runId: claim.runId,
    startSeq:
      startSeq != null && endSeq != null
        ? Math.min(startSeq, endSeq)
        : startSeq,
    endSeq:
      startSeq != null && endSeq != null ? Math.max(startSeq, endSeq) : endSeq,
    messageIds: new Set((claim.messageIds ?? []).filter(Boolean)),
  };
  logger.debug(
    {
      groupJid,
      runId: claim.runId,
      startSeq: state.activeMessageRunInput.startSeq,
      endSeq: state.activeMessageRunInput.endSeq,
      messageCount: state.activeMessageRunInput.messageIds.size,
    },
    'Recorded message input claimed by active run',
  );
  return true;
}

export function isActiveMessageRunInput(
  state: GroupState,
  message: NewMessage,
): boolean {
  const claim = state.activeMessageRunInput;
  if (
    !claim ||
    state.currentRunId !== claim.runId ||
    (state.runPhase !== 'running_messages' &&
      state.runPhase !== 'closing_messages')
  ) {
    return false;
  }

  if (message.seq != null && claim.startSeq != null && claim.endSeq != null) {
    return message.seq >= claim.startSeq && message.seq <= claim.endSeq;
  }

  return claim.messageIds.has(message.id);
}

export function noteDirectTerminalDelivery(
  state: GroupState,
  groupJid: string,
  senderRole?: string | null,
  text?: string | null,
): void {
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

export function hasDirectTerminalDeliveryForRun(
  state: GroupState,
  runId: string,
  senderRole?: string | null,
): boolean {
  if (state.currentRunId !== runId || !senderRole) {
    return false;
  }
  return state.directTerminalDeliveries.has(senderRole);
}

export function getDirectTerminalDeliveryForRun(
  state: GroupState,
  runId: string,
  senderRole?: string | null,
): string | null {
  if (state.currentRunId !== runId || !senderRole) {
    return null;
  }
  return state.directTerminalDeliveries.get(senderRole) ?? null;
}

export function getCloseReasonForRun(
  state: GroupState,
  runId: string,
): string | null {
  const closeRequest = state.lastCloseRequest;
  return closeRequest?.runId === runId ? closeRequest.reason : null;
}

export function hasRecordedDirectTerminalDeliveryForRun(
  state: GroupState,
  runId: string,
  senderRole?: string | null,
): boolean {
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
