export const PROGRESS_EDIT_INTERVAL_MS = 2_000;

export function progressEditDelayMs(lastEditAt: number, now = Date.now()): number {
  if (lastEditAt <= 0) return 0;
  return Math.max(0, PROGRESS_EDIT_INTERVAL_MS - (now - lastEditAt));
}

/**
 * Coalesces streaming events into serialized Discord message edits.
 * A second edit cannot be scheduled while the previous Discord request awaits.
 */
export class ProgressEditGate {
  private dirty = false;
  private scheduled = false;
  private editing = false;
  private lastEditAt = 0;

  markDirty(): void {
    this.dirty = true;
  }

  scheduleDelay(now = Date.now()): number | null {
    if (!this.dirty || this.scheduled || this.editing) return null;
    this.scheduled = true;
    return progressEditDelayMs(this.lastEditAt, now);
  }

  beginEdit(): boolean {
    if (!this.scheduled || this.editing || !this.dirty) return false;
    this.scheduled = false;
    this.editing = true;
    this.dirty = false;
    return true;
  }

  finishEdit(now = Date.now(), committed = true, retry = !committed): void {
    this.editing = false;
    if (committed) this.lastEditAt = now;
    else if (retry) this.dirty = true;
  }

  recordEdit(now = Date.now()): void {
    this.lastEditAt = now;
  }
}
