import { buildGoalPrompt } from "./protocol";
import type {
  ClaudeExecution,
  ClaudeExecutor,
  FinalHook,
  JobRecord,
  PreflightHook,
  PrepareRouteHook,
  ProgressHook,
  QuestionHook,
  RouteConfig,
  StartHook,
} from "./types";
import { StateStore } from "./store";

interface RuntimeOptions {
  store: StateStore;
  routes: Map<string, RouteConfig>;
  executor: ClaudeExecutor;
  onFinal: FinalHook;
  preflight?: PreflightHook;
  onStart?: StartHook;
  onProgress?: ProgressHook;
  onQuestion?: QuestionHook;
  prepareRoute?: PrepareRouteHook;
  maxConcurrent: number;
  maxAttempts: number;
  deliveryRetryMs?: number;
}

export class JobRuntime {
  private readonly store: StateStore;
  private readonly routes: Map<string, RouteConfig>;
  private readonly executor: ClaudeExecutor;
  private readonly onFinal: FinalHook;
  private readonly preflight: PreflightHook | undefined;
  private readonly onStart: StartHook | undefined;
  private readonly onProgress: ProgressHook | undefined;
  private readonly onQuestion: QuestionHook | undefined;
  private readonly prepareRoute: PrepareRouteHook | undefined;
  private readonly maxConcurrent: number;
  private readonly maxAttempts: number;
  private readonly deliveryRetryMs: number;
  private pumpPromise: Promise<void> | null = null;

  constructor(options: RuntimeOptions) {
    this.store = options.store;
    this.routes = options.routes;
    this.executor = options.executor;
    this.onFinal = options.onFinal;
    this.preflight = options.preflight;
    this.onStart = options.onStart;
    this.onProgress = options.onProgress;
    this.onQuestion = options.onQuestion;
    this.prepareRoute = options.prepareRoute;
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
      subagentModels: current.subagentModels,
    };
    if (current.mainModel) execution.mainModel = current.mainModel;
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

    if (this.preflight) {
      try {
        const decision = await this.preflight(job);
        if (!decision.ok) {
          this.store.cancelJob(job.id, `preflight rejected: ${decision.reason}`);
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.retryOrFail(job.id, {
          ok: false,
          result: `preflight failed: ${message}`,
          sessionId: job.sessionId,
          stderr: message,
          exitCode: 1,
        }, this.maxAttempts);
        return;
      }
    }

    let preparedRoute = route;
    if (this.prepareRoute) {
      try {
        preparedRoute = await this.prepareRoute(route, job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.retryOrFail(
          job.id,
          {
            ok: false,
            result: `conversation worktree preparation failed: ${message}`,
            sessionId: job.sessionId,
            stderr: message,
            exitCode: 1,
          },
          this.maxAttempts,
        );
        return;
      }
    }

    if (this.onStart) {
      try {
        await this.onStart(job);
      } catch (error) {
        console.warn("start hook failed", error);
      }
    }
    if (this.store.getJob(job.id)?.status === "cancelled") return;

    const settings = this.store.getConversationSettings(job.conversationKey);
    const effectiveRoute: RouteConfig = {
      ...preparedRoute,
      model: settings.model ?? preparedRoute.model,
      permissionMode: settings.permissionMode ?? preparedRoute.permissionMode,
      effort: settings.effort ?? preparedRoute.effort,
    };
    const hasContinuation = Boolean(job.continuationPrompt && job.continuationSessionId);
    const sourceSessionId = job.continuationSessionId ?? job.sessionId;
    const resume = hasContinuation || job.pinnedSession || job.startedBefore || this.store.sessionHasHistory(job.conversationKey);
    const sessionWorkspace = this.store.sessionWorkspaceForSession(job.conversationKey, sourceSessionId);
    const workspaceMoved =
      resume &&
      sessionWorkspace !== effectiveRoute.cwd &&
      (effectiveRoute.conversationWorktrees === true || sessionWorkspace !== null);
    const requestedFork = resume && this.store.consumeFork(job.conversationKey);
    const preserveSourceBranch =
      requestedFork &&
      Boolean(this.store.sessionBranchForSession(job.conversationKey, sourceSessionId)?.workspaceRevision);
    const forkSession = resume && (workspaceMoved || requestedFork);
    const recoverySteering = job.recoveryReason ? this.store.listRecoverySteeringInputs(job.id) : [];
    const taskPrompt =
      recoverySteering.length === 0
        ? job.prompt
        : [
            job.prompt,
            "",
            "[재시작 경계의 Discord 추가 지시 최종 상태]",
            "아래 각 message의 현재 상태를 기준으로 처리해. 이미 반영한 동일 지시는 중복 실행하지 마.",
            ...recoverySteering.flatMap((input) =>
              input.state === "deleted"
                ? [
                    `message=${input.messageId} state=deleted original_sdk_message=${input.originalSdkMessageId}`,
                    "이 Discord 추가 지시와 관련된 원본 및 모든 수정본은 삭제됐으므로 더 이상 따르지 마.",
                  ]
                : [
                    `message=${input.messageId} state=${input.state} original_sdk_message=${input.originalSdkMessageId}`,
                    input.content,
                  ],
            ),
          ].join("\n");
    const prompt = hasContinuation
      ? job.continuationPrompt!
      : job.rawPrompt
        ? job.prompt
        : buildGoalPrompt(effectiveRoute, taskPrompt, job.attachmentPaths, job.recoveryReason);
    let execution: ClaudeExecution;
    try {
      execution = await this.executor({
        job,
        route: effectiveRoute,
        prompt,
        sessionId: sourceSessionId,
        resume,
        forkSession,
        continuationTurn: job.continuationTurn,
        onSpawn: (pid) => this.store.setPid(job.id, pid),
        onHeartbeat: () => this.store.heartbeat(job.id),
        onCheckpoint: (userMessageId) => this.store.recordSessionCheckpoint(job.id, userMessageId),
        onSessionEstablished: (sessionId) =>
          this.store.establishExecutionSession(job.id, sessionId, effectiveRoute.cwd, preserveSourceBranch),
        onContinuation: (continuationPrompt, continuationSessionId, continuationTurn) =>
          this.store.stageContinuation(job.id, continuationPrompt, continuationSessionId, continuationTurn),
        ...(this.onQuestion
          ? {
              onQuestion: (question: Parameters<QuestionHook>[1]) =>
                this.onQuestion!(this.store.getJob(job.id) ?? job, question),
            }
          : {}),
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
        sessionId: sourceSessionId,
        stderr: "executor threw",
        exitCode: 1,
      };
    }

    const current = this.store.getJob(job.id);
    if (current?.status === "cancelled") return;
    if (execution.ok) {
      this.store.acceptPendingSteeringInputs(job.id);
      this.store.stageDelivery(job.id, execution, "completed", effectiveRoute.cwd);
      return;
    }
    this.store.retryOrFail(job.id, execution, this.maxAttempts);
  }
}
