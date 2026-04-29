import { getOwnerCodexBadRequestFailureSummaryForTask } from './db.js';
import { getEnv } from './env.js';
import { logger } from './logger.js';
import type { PairedTurnIdentity } from './paired-turn-identity.js';
import type {
  AgentType,
  Channel,
  PairedRoomRole,
  VisiblePhase,
} from './types.js';

const DEFAULT_CODEX_BAD_REQUEST_REPEAT_THRESHOLD = 3;

export function getCodexBadRequestRepeatThreshold(): number {
  const raw = getEnv('CODEX_BAD_REQUEST_REPEAT_THRESHOLD');
  if (!raw) {
    return DEFAULT_CODEX_BAD_REQUEST_REPEAT_THRESHOLD;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 2) {
    return DEFAULT_CODEX_BAD_REQUEST_REPEAT_THRESHOLD;
  }
  return parsed;
}

export async function notifyOwnerCodexBadRequestObservation(args: {
  chatJid: string;
  runId: string;
  groupFolder: string;
  channel: Pick<Channel, 'sendMessage'>;
  outputStatus: 'success' | 'error';
  visiblePhase: VisiblePhase;
  deliveryRole: PairedRoomRole | null;
  agentType: AgentType;
  pairedTurnIdentity: PairedTurnIdentity | null;
  threshold?: number;
}): Promise<boolean> {
  if (
    args.outputStatus !== 'error' ||
    args.visiblePhase !== 'silent' ||
    args.agentType !== 'codex'
  ) {
    return false;
  }

  const role = args.pairedTurnIdentity?.role ?? args.deliveryRole;
  if (role !== 'owner' || !args.pairedTurnIdentity) {
    return false;
  }

  const threshold = args.threshold ?? getCodexBadRequestRepeatThreshold();
  const summary = getOwnerCodexBadRequestFailureSummaryForTask({
    taskId: args.pairedTurnIdentity.taskId,
    threshold,
  });
  if (!summary || summary.failures !== threshold) {
    return false;
  }

  const message = [
    `🟡 owner Codex 세션이 {"detail":"Bad Request"}로 ${summary.failures}회 연속 무출력 실패했습니다.`,
    '자동복구는 아직 비활성화되어 있습니다. 현재는 감지만 수행하며, 필요하면 `/clear`로 세션을 초기화해 주세요.',
    `task=${summary.taskId}`,
    `latest=${summary.latestFailureAt}`,
  ].join('\n');

  try {
    await args.channel.sendMessage(args.chatJid, message);
  } catch (err) {
    logger.warn(
      {
        err,
        chatJid: args.chatJid,
        runId: args.runId,
        groupFolder: args.groupFolder,
        taskId: summary.taskId,
      },
      'Failed to send owner Codex Bad Request observation notice',
    );
    return false;
  }

  logger.warn(
    {
      chatJid: args.chatJid,
      runId: args.runId,
      groupFolder: args.groupFolder,
      taskId: summary.taskId,
      failures: summary.failures,
      firstFailureAt: summary.firstFailureAt,
      latestFailureAt: summary.latestFailureAt,
    },
    'Detected repeated owner Codex Bad Request failures without visible output',
  );
  return true;
}
