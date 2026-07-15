export interface ElapsedFormatOptions {
  bucketSeconds?: number;
  includeSecondsWithHours?: boolean;
}

export function formatElapsedKorean(
  elapsedSeconds: number,
  options: ElapsedFormatOptions = {},
): string {
  const bucketSeconds = Math.max(1, Math.floor(options.bucketSeconds ?? 1));
  const totalSeconds = Math.floor(Math.max(0, elapsedSeconds) / bucketSeconds) * bucketSeconds;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}시간`);
    if (minutes > 0) parts.push(`${minutes}분`);
    if (options.includeSecondsWithHours && seconds > 0) parts.push(`${seconds}초`);
    return parts.join(" ");
  }

  if (minutes > 0) parts.push(`${minutes}분`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}초`);
  return parts.join(" ");
}

export function workElapsedSeconds(
  startedAt: string | null,
  createdAt: string,
  nowMs = Date.now(),
): number {
  const startMs = Date.parse(startedAt ?? createdAt);
  if (!Number.isFinite(startMs)) return 0;
  return Math.max(0, Math.round((nowMs - startMs) / 1_000));
}

export function progressElapsedSeconds(
  startedAt: string | null,
  createdAt: string,
  nowMs = Date.now(),
): number {
  return workElapsedSeconds(startedAt, createdAt, nowMs);
}
