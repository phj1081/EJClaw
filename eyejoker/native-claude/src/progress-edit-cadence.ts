export const PROGRESS_EDIT_INTERVAL_MS = 2_000;

export function progressEditDelayMs(lastEditAt: number, now = Date.now()): number {
  if (lastEditAt <= 0) return 0;
  return Math.max(0, PROGRESS_EDIT_INTERVAL_MS - (now - lastEditAt));
}
