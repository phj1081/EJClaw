import { TIMEZONE } from './config.js';
import type { ScheduledTask } from './types.js';
import { formatElapsedKorean } from './utils.js';

export type WatcherStatusPhase =
  | 'checking'
  | 'waiting'
  | 'retrying'
  | 'completed';

export const WATCH_CI_PREFIX = '[BACKGROUND CI WATCH]';
export const TASK_STATUS_MESSAGE_PREFIX = '\u2063\u2063\u2063';
export const DEFAULT_WATCH_CI_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export function isWatchCiTask(task: Pick<ScheduledTask, 'prompt'>): boolean {
  return task.prompt.startsWith(WATCH_CI_PREFIX);
}

export function isTaskStatusControlMessage(content: string): boolean {
  return content.startsWith(TASK_STATUS_MESSAGE_PREFIX);
}

export function extractWatchCiTarget(prompt: string): string | null {
  const match = prompt.match(/Watch target:\n([\s\S]*?)\n\nTask ID:/);
  return match?.[1]?.trim() || null;
}

function formatTimeLabel(timestampIso: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: TIMEZONE,
  })
    .format(new Date(timestampIso))
    .replace(/:/g, '시 ')
    .replace(/시 (\d{2})$/, '분 $1초');
}

function formatWatchIntervalLabel(
  task: Pick<ScheduledTask, 'schedule_type' | 'schedule_value'>,
): string | null {
  if (task.schedule_type !== 'interval') return null;
  const ms = parseInt(task.schedule_value, 10);
  if (!Number.isFinite(ms) || ms <= 0) return null;

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}초`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${totalMinutes}분 ${seconds}초` : `${totalMinutes}분`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
}

function formatElapsedLabel(
  startedAtIso: string,
  checkedAtIso: string,
): string {
  const elapsedMs = Math.max(
    0,
    new Date(checkedAtIso).getTime() - new Date(startedAtIso).getTime(),
  );
  return formatElapsedKorean(elapsedMs);
}

export function renderWatchCiStatusMessage(args: {
  task: Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value'>;
  phase: WatcherStatusPhase;
  checkedAt: string;
  statusStartedAt?: string | null;
  nextRun?: string | null;
}): string {
  const target = extractWatchCiTarget(args.task.prompt) || 'CI watcher';
  const title =
    args.phase === 'completed'
      ? `CI 감시 종료: ${target}`
      : `CI 감시 중: ${target}`;
  const statusLabel =
    args.phase === 'checking'
      ? '확인 중'
      : args.phase === 'retrying'
        ? '재시도 대기'
        : args.phase === 'completed'
          ? '완료'
          : '대기 중';

  const lines = [
    title,
    `- 상태: ${statusLabel}`,
    `- 마지막 확인: ${formatTimeLabel(args.checkedAt)}`,
  ];
  if (args.statusStartedAt) {
    lines.push(
      `- 경과 시간: ${formatElapsedLabel(args.statusStartedAt, args.checkedAt)}`,
    );
  }
  const intervalLabel = formatWatchIntervalLabel(args.task);
  if (intervalLabel) {
    lines.push(`- 확인 간격: ${intervalLabel}`);
  }

  if (args.nextRun) {
    lines.push(`- 다음 확인: ${formatTimeLabel(args.nextRun)}`);
  }
  return lines.join('\n');
}

export function getTaskQueueJid(
  task: Pick<ScheduledTask, 'chat_jid' | 'context_mode' | 'id' | 'prompt'>,
): string {
  return task.context_mode === 'isolated' || isWatchCiTask(task)
    ? `${task.chat_jid}::task:${task.id}`
    : task.chat_jid;
}

export function getTaskRuntimeTaskId(
  task: Pick<ScheduledTask, 'context_mode' | 'id' | 'prompt'>,
): string | undefined {
  return task.context_mode === 'isolated' || isWatchCiTask(task)
    ? task.id
    : undefined;
}

export function shouldUseTaskScopedSession(
  task: Pick<ScheduledTask, 'context_mode'>,
): boolean {
  return task.context_mode === 'isolated';
}
