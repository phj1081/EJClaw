import type { DashboardTask, DashboardTaskAction } from './api';
import { localeTags, type Locale, type Messages } from './i18n';

export function formatDate(
  value: string | null | undefined,
  locale: Locale,
): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = Date.now();
  const ageMs = now - date.getTime();
  if (ageMs >= 0 && ageMs < 60_000) {
    return locale === 'ko'
      ? '방금'
      : locale === 'ja'
        ? 'たった今'
        : locale === 'zh'
          ? '刚刚'
          : 'just now';
  }
  if (ageMs >= 0 && ageMs < 3_600_000) {
    const mins = Math.floor(ageMs / 60_000);
    return locale === 'ko'
      ? `${mins}분 전`
      : locale === 'ja'
        ? `${mins}分前`
        : locale === 'zh'
          ? `${mins} 分钟前`
          : `${mins}m ago`;
  }
  const sameDay = new Date().toDateString() === date.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat(localeTags[locale], {
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
    }).format(date);
  }
  const time = new Intl.DateTimeFormat(localeTags[locale], {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
  }).format(date);
  if (locale === 'ko')
    return `${date.getMonth() + 1}월 ${date.getDate()}일 ${time}`;
  if (locale === 'ja')
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  if (locale === 'zh')
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  return new Intl.DateTimeFormat(localeTags[locale], {
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: 'short',
  }).format(date);
}

export function taskActionsFor(task: DashboardTask): DashboardTaskAction[] {
  if (task.status === 'active') return ['pause', 'cancel'];
  if (task.status === 'paused') return ['resume', 'cancel'];
  return [];
}

export function statusLabel(status: string, t: Messages): string {
  if (status in t.status) return t.status[status as keyof Messages['status']];
  return status;
}
