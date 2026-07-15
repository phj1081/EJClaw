interface Waiter<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

export class AsyncMailbox<T> implements AsyncIterable<T> {
  private readonly queued: T[] = [];
  private readonly waiters: Waiter<T>[] = [];
  private closed = false;
  private failure: unknown;

  push(value: T): boolean {
    if (this.closed || this.failure !== undefined) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.queued.push(value);
    return true;
  }

  replace(predicate: (value: T) => boolean, replacement: T): boolean {
    if (this.closed || this.failure !== undefined) return false;
    const index = this.queued.findIndex(predicate);
    if (index < 0) return false;
    this.queued[index] = replacement;
    return true;
  }

  remove(predicate: (value: T) => boolean): boolean {
    if (this.closed || this.failure !== undefined) return false;
    const index = this.queued.findIndex(predicate);
    if (index < 0) return false;
    this.queued.splice(index, 1);
    return true;
  }

  close(): void {
    if (this.closed || this.failure !== undefined) return;
    this.closed = true;
    if (this.queued.length === 0) this.finishWaiters();
  }

  abort(error: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.closed = true;
    this.queued.length = 0;
    while (this.waiters.length > 0) this.waiters.shift()?.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.failure !== undefined) return Promise.reject(this.failure);
        const value = this.queued.shift();
        if (value !== undefined) {
          if (this.closed && this.queued.length === 0) this.finishWaiters();
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }

  private finishWaiters(): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: undefined, done: true });
    }
  }
}
