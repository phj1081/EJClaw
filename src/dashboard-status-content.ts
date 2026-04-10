import { STATUS_SHOW_ROOM_DETAILS, STATUS_SHOW_ROOMS } from './config.js';
import {
  composeDashboardContent,
  type DashboardRoomLine,
  getStatusLabel,
  renderCategorizedRoomSections,
} from './dashboard-render.js';
import type { GroupQueue } from './group-queue.js';
import type { AgentType, Channel, RegisteredGroup } from './types.js';

export interface DashboardOptions {
  assistantName: string;
  channels: Channel[];
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  roomBindings: () => Record<string, RegisteredGroup>;
  statusChannelId: string;
  statusUpdateInterval: number;
  usageUpdateInterval: number;
  serviceAgentType?: AgentType;
}

function getSessionLabel(sessionId: string | undefined): string {
  if (!sessionId) return '세션 없음';
  const shortId = sessionId.length > 8 ? sessionId.slice(-8) : sessionId;
  return `세션 ${shortId}`;
}

export function buildStatusContent(opts: DashboardOptions): string {
  if (!STATUS_SHOW_ROOMS) return '';

  const sessions = opts.getSessions();
  const groups = opts.roomBindings();
  const statuses = opts.queue.getStatuses(Object.keys(groups));

  let totalActive = 0;
  let totalWaiting = 0;
  const roomLines: DashboardRoomLine[] = statuses
    .map((status) => {
      const group = groups[status.jid];
      if (!group) return null;
      if (status.status === 'processing') totalActive += 1;
      if (status.status === 'waiting') totalWaiting += 1;
      return {
        category: '기타',
        categoryPosition: 999,
        position: 999,
        line: `  **${group.name}** — ${getStatusLabel(status)} · ${getSessionLabel(sessions[group.folder])}`,
      };
    })
    .filter((line): line is DashboardRoomLine => Boolean(line));

  const header = `**에이전트 상태** (${opts.assistantName}) — 활성 ${totalActive} | 큐대기 ${totalWaiting} | 전체 ${roomLines.length}`;
  if (!STATUS_SHOW_ROOM_DETAILS) {
    return composeDashboardContent([header]);
  }

  return composeDashboardContent([
    `${header}\n\n${renderCategorizedRoomSections({
      lines: roomLines,
      showCategoryHeaders: false,
    })}`,
  ]);
}
