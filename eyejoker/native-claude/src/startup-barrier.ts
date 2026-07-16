export class StartupBarrier {
  private readonly promise: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;
  private settled = false;

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    void this.promise.catch(() => undefined);
  }

  wait(): Promise<void> {
    return this.promise;
  }

  ready(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve();
  }

  fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.reject(error);
  }
}
