import { buildGoalPrompt } from "./protocol";
import type {
  ClaudeExecution,
  ClaudeExecutor,
  FinalHook,
  JobRecord,
  ProgressHook,
  RouteConfig,
  StartHook,
} from "./types";
import { StateStore } from "./store";

interface RuntimeOptions {
  store: StateStore;
  routes: Map<string, RouteConfig>;
  executor: ClaudeExecutor;
  onFinal: FinalHook;
  onStart?: StartHook;
  onProgress?: ProgressHook;
  maxConcurrent: number;
  maxAttempts: number;
  deliveryRetryMs?: number;
}

export class JobRuntime {
  private readonly store: StateStore;
  private readonly routes: Map<string, RouteConfig>;
  private readonly executor: ClaudeExecutor;
  private readonly onFinal: FinalHook;
  private readonly onStart: StartHook | undefined;
  private readonly onProgress: ProgressHook | undefined;
  private readonly maxConcurrent: number;
  private readonly maxAttempts: number;
  private readonly deliveryRetryMs: number;
  private pumpPromise: Promise<void> | null = null;

  constructor(options: RuntimeOptions) {
    this.store = options.store;
    this.routes = options.routes;
    this.executor = options.executor;
    this.onFinal = options.onFinal;
    this.onStart = options.onStart;
    this.onProgress = options.onProgress;
    this.maxConcurrent = options.maxConcurrent;
    this.maxAttempts = options.maxAttempts;
    this.deliveryRetryMs = options.deliveryRetryMs ?? 5_000;
  }

  recoverInterrupted(reason = "bridge service restart"): number {
    return this.store.recoverInterrupted(reason, this.maxAttempts);
  }

  runUntilIdle(): Promise<void> {
    if (!this.pumpPromise) {
      this.pumpPromise = this.pump().finally(() => {
        this.pumpPromise = null;
        if (this.store.hasQueued()) queueMicrotask(() => void this.runUntilIdle());
      });
    }
    return this.pumpPromise;
  }

  private async pump(): Promise<void> {
    const active = new Set<Promise<void>>();
    const attemptedDeliveries = new Set<string>();
    while (true) {
      const delivery = this.store
        .listDueDeliveries()
        .find((candidate) => !attemptedDeliveries.has(candidate.id));
      if (delivery) {
        attemptedDeliveries.add(delivery.id);
        await this.deliver(delivery);
        continue;
      }

      while (active.size < this.maxConcurrent) {
        const job = this.store.claimNext(this.maxConcurrent);
        if (!job) break;
        let task!: Promise<void>;
        task = this.runJob(job).finally(() => active.delete(task));
        active.add(task);
      }
      if (active.size === 0) return;
      await Promise.race(active);
    }
  }

  private async deliver(job: JobRecord): Promise<void> {
    const current = this.store.getJob(job.id);
    if (!current || current.status !== "delivering") return;
    const execution: ClaudeExecution = {
      ok: current.finalStatus === "completed",
      result: current.result ?? current.error ?? "결과 없음",
      sessionId: current.sessionId,
      stderr: current.error ?? "",
      exitCode: current.finalStatus === "completed" ? 0 : 1,
    };
    try {
      await this.onFinal(current, execution);
      this.store.markDelivered(current.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.deferDelivery(current.id, message, this.deliveryRetryMs);
      console.warn(`final delivery deferred id=${current.id}`, message);
    }
  }

  private async runJob(job: JobRecord): Promise<void> {
    const route = this.routes.get(job.routeId);
    if (!route) {
      const execution: ClaudeExecution = {
        ok: false,
        result: `route not found: ${job.routeId}`,
        sessionId: job.sessionId,
        stderr: "",
        exitCode: 2,
      };
      this.store.retryOrFail(job.id, execution, 1);
      return;
    }

    if (this.onStart) {
      try {
        await this.onStart(job);
      } catch (error) {
        console.warn("start hook failed", error);
      }
    }
    if (this.store.getJob(job.id)?.status === "cancelled") return;

    const resume = job.startedBefore || this.store.sessionHasHistory(job.conversationKey);
    const prompt = buildGoalPrompt(route, job.prompt, job.attachmentPaths, job.recoveryReason);
    let execution: ClaudeExecution;
    try {
      execution = await this.executor({
        job,
        route,
        prompt,
        sessionId: job.sessionId,
        resume,
        onSpawn: (pid) => this.store.setPid(job.id, pid),
        onHeartbeat: () => this.store.heartbeat(job.id),
        onProgress: (event, aggregator) => {
          if (!this.onProgress) return;
          const current = this.store.getJob(job.id) ?? job;
          void Promise.resolve(this.onProgress(current, event, aggregator)).catch((error) =>
            console.warn("progress hook failed", error),
          );
        },
      });
    } catch (error) {
      execution = {
        ok: false,
        result: error instanceof Error ? error.message : String(error),
        sessionId: job.sessionId,
        stderr: "executor threw",
        exitCode: 1,
      };
    }

    const current = this.store.getJob(job.id);
    if (current?.status === "cancelled") return;
    if (execution.ok) {
      this.store.stageDelivery(job.id, execution, "completed");
      return;
    }
    this.store.retryOrFail(job.id, execution, this.maxAttempts);
  }
}
