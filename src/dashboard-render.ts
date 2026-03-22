import { STATUS_SHOW_ROOMS } from './config.js';
import type { GroupStatus } from './group-queue.js';

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m${rem.toString().padStart(2, '0')}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h < 24) return `${h}h${m.toString().padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}d${remH}h`;
}

export function getStatusLabel(status: {
  status: GroupStatus['status'];
  elapsedMs: number | null;
  pendingTasks: number;
}): string {
  if (status.status === 'processing') {
    return `처리 중 (${formatElapsed(status.elapsedMs || 0)})`;
  }
  if (status.status === 'waiting') {
    return status.pendingTasks > 0
      ? `큐 대기 (태스크 ${status.pendingTasks}개)`
      : '큐 대기 (메시지)';
  }
  return '비활성';
}

export interface DashboardRoomLine {
  category: string;
  categoryPosition: number;
  position: number;
  line: string;
}

export function renderCategorizedRoomSections(args: {
  lines: DashboardRoomLine[];
  showCategoryHeaders: boolean;
}): string {
  const { lines, showCategoryHeaders } = args;
  const categoryMap = new Map<string, DashboardRoomLine[]>();

  for (const line of lines) {
    if (!categoryMap.has(line.category)) {
      categoryMap.set(line.category, []);
    }
    categoryMap.get(line.category)!.push(line);
  }

  const sortedCategories = [...categoryMap.entries()].sort(
    ([, a], [, b]) =>
      (a[0]?.categoryPosition ?? Number.MAX_SAFE_INTEGER) -
      (b[0]?.categoryPosition ?? Number.MAX_SAFE_INTEGER),
  );

  return sortedCategories
    .map(([category, entries]) => {
      entries.sort((a, b) => a.position - b.position);
      const content = entries.map((entry) => entry.line).join('\n');
      if (!showCategoryHeaders || category === '기타') {
        return content;
      }
      return `📁 **${category}**\n${content}`;
    })
    .join('\n\n');
}

export function composeDashboardContent(
  sections: string[],
  now = new Date(),
): string {
  const parts = sections.map((section) => section.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  parts.push(
    `_${now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}_`,
  );
  return parts.join('\n\n');
}

export function shouldShowRoomStatus(): boolean {
  return STATUS_SHOW_ROOMS;
}
