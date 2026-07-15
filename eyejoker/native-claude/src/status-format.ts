import type { JobRecord } from "./types";

export interface StatusJob {
  id: string;
  route: string;
  conversation: string;
  attempts: number;
  pid: number | null;
  started_at: string | null;
  heartbeat_at: string | null;
}

export interface StatusSnapshot {
  state: "working" | "stalled" | "delivering" | "queued" | "idle";
  running: StatusJob[];
  delivering: StatusJob[];
  queued: StatusJob[];
  generated_at: string;
}

function summarize(job: JobRecord): StatusJob {
  return {
    id: job.id,
    route: job.routeId,
    conversation: job.conversationKey,
    attempts: job.attempts,
    pid: job.pid,
    started_at: job.startedAt,
    heartbeat_at: job.heartbeatAt,
  };
}

export function renderStatusSnapshot(
  jobs: JobRecord[],
  currentTime = new Date().toISOString(),
  staleAfterSeconds = 45,
): StatusSnapshot {
  const runningJobs = jobs.filter((job) => job.status === "running");
  const deliveringJobs = jobs.filter((job) => job.status === "delivering");
  const queuedJobs = jobs.filter((job) => job.status === "queued");
  const nowMs = Date.parse(currentTime);
  const stalled = runningJobs.some((job) => {
    const heartbeat = Date.parse(job.heartbeatAt ?? job.startedAt ?? job.createdAt);
    return Number.isFinite(nowMs) && Number.isFinite(heartbeat) && nowMs - heartbeat > staleAfterSeconds * 1000;
  });
  return {
    state:
      runningJobs.length > 0
        ? stalled
          ? "stalled"
          : "working"
        : deliveringJobs.length > 0
          ? "delivering"
          : queuedJobs.length > 0
            ? "queued"
            : "idle",
    running: runningJobs.map(summarize),
    delivering: deliveringJobs.map(summarize),
    queued: queuedJobs.map(summarize),
    generated_at: currentTime,
  };
}

export function formatDiscordStatus(snapshot: StatusSnapshot): string {
  if (snapshot.state === "idle") return "🟢 idle — 처리 중인 작업 없음";
  const rows = [
    `${
      snapshot.state === "stalled"
        ? "🔴 stalled"
        : snapshot.state === "working"
          ? "🟡 working"
          : snapshot.state === "delivering"
            ? "🔵 delivering"
            : "🟠 queued"
    }`,
  ];
  for (const job of snapshot.running) rows.push(`├ ${job.route} · 실행 중 · attempt ${job.attempts}`);
  for (const job of snapshot.delivering) rows.push(`├ ${job.route} · 최종 전달 대기`);
  for (const [index, job] of snapshot.queued.entries()) {
    rows.push(`${index === snapshot.queued.length - 1 ? "└" : "├"} ${job.route} · 대기`);
  }
  return rows.join("\n");
}
