import { TASK_STATUS_MESSAGE_PREFIX } from './task-watch-status.js';
import { formatElapsedKorean } from './utils.js';

export interface SubagentTrack {
  label: string;
  activities: string[];
}

export function recordSubagentToolActivity(
  subagents: Map<string, SubagentTrack>,
  agentId: string,
  text: string | null,
): void {
  let track = subagents.get(agentId);
  if (!track) {
    track = { label: '작업 중...', activities: [] };
    subagents.set(agentId, track);
  }
  if (text) {
    const MAX = 2;
    track.activities.push(text);
    if (track.activities.length > MAX) {
      track.activities = track.activities.slice(-MAX);
    }
  }
}

export function recordSubagentProgress(
  subagents: Map<string, SubagentTrack>,
  args: {
    agentId: string;
    agentDone?: boolean;
    agentLabel?: string;
    text: string | null;
  },
): void {
  if (args.agentDone) {
    const done = subagents.get(args.agentId);
    if (done) {
      done.label = done.label.replace('🔄', '✅');
      done.activities = [];
    }
    return;
  }
  const label =
    args.text || (args.agentLabel ? `🔄 ${args.agentLabel}` : '작업 중...');
  const existing = subagents.get(args.agentId);
  if (existing) {
    existing.label = label;
    existing.activities = [];
  } else {
    subagents.set(args.agentId, { label, activities: [] });
  }
}

export function composeProgressBody(args: {
  text: string;
  subagents: ReadonlyMap<string, SubagentTrack>;
  toolActivities: readonly string[];
}): string {
  const { text, subagents, toolActivities } = args;
  if (subagents.size > 1) {
    const lines: string[] = [];
    for (const [, track] of subagents) {
      const latest = track.activities[track.activities.length - 1];
      lines.push(latest ? `${track.label} · ${latest}` : track.label);
    }
    return lines.join('\n');
  }
  if (subagents.size === 1) {
    const [, track] = subagents.entries().next().value!;
    const lines: string[] = [track.label];
    for (let i = 0; i < track.activities.length; i++) {
      const isLast = i === track.activities.length - 1;
      lines.push(`${isLast ? '└' : '├'}  ${track.activities[i]}`);
    }
    return lines.join('\n');
  }
  const activityLines =
    toolActivities.length > 0
      ? '\n' +
        toolActivities
          .map((a, i) => {
            const isLast = i === toolActivities.length - 1;
            const connector = isLast ? '└' : '├';
            const isSummary = a.startsWith('📋');
            return isSummary ? `${connector} ${a}` : `${connector}  ${a}`;
          })
          .join('\n')
      : '';
  return text + activityLines;
}

export function renderProgressMessage(args: {
  text: string;
  progressStartedAt: number | null;
  subagents: ReadonlyMap<string, SubagentTrack>;
  toolActivities: readonly string[];
  persistProgressBody: (body: string) => void;
}): string {
  const elapsedMs =
    args.progressStartedAt === null
      ? 0
      : Math.floor((Date.now() - args.progressStartedAt) / 5_000) * 5000;

  const suffix = `\n\n${formatElapsedKorean(elapsedMs)}`;
  const body = composeProgressBody({
    text: args.text,
    subagents: args.subagents,
    toolActivities: args.toolActivities,
  });

  args.persistProgressBody(body);

  const maxBody = 2000 - TASK_STATUS_MESSAGE_PREFIX.length - suffix.length;
  const truncated =
    body.length > maxBody ? body.slice(0, maxBody - 1) + '…' : body;
  return `${TASK_STATUS_MESSAGE_PREFIX}${truncated}${suffix}`;
}
