import { describe, expect, test } from "bun:test";
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSdkExecutor, remainingExecutionMs, type SdkQueryFactory } from "../src/sdk-executor";
import type { ExecutionRequest, InteractiveQuestion } from "../src/types";

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    job: {
      id: "job-sdk",
      routeId: "repo",
      lockKey: "repo",
      conversationKey: "discord:guild:channel",
      channelId: "channel",
      threadId: null,
      messageId: "message",
      authorId: "owner",
      prompt: "task",
      rawPrompt: false,
      attachmentPaths: [],
      status: "running",
      sessionId: "11111111-1111-4111-8111-111111111111",
      attempts: 1,
      startedBefore: false,
      recoveryReason: null,
      pid: null,
      result: null,
      error: null,
      finalStatus: null,
      deliveryAttempts: 0,
      deliveryAfter: null,
      deliveryError: null,
      deliveryChunks: null,
      deliveryFiles: [],
      deliveryCursor: 0,
      deliveryMessageIds: [],
      progressMessageId: null,
      progressText: null,
      mainModel: null,
      subagentModels: [],
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      heartbeatAt: null,
      completedAt: null,
    },
    route: {
      id: "repo",
      discordChannelId: "channel",
      cwd: "/tmp",
      model: "claude-fable-5",
      fallbackModel: "gpt-5.6-sol",
      permissionMode: "bypassPermissions",
      effort: "high",
      requireMention: false,
    },
    prompt: "SDK TASK",
    sessionId: "11111111-1111-4111-8111-111111111111",
    resume: false,
    ...overrides,
  };
}

function result(sessionId = "sdk-session"): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "SDK_OK",
    session_id: sessionId,
    total_cost_usd: 0,
    usage: {} as never,
    uuid: crypto.randomUUID(),
  };
}

describe("ClaudeSdkExecutor", () => {
  test("keeps one absolute timeout budget across retries", () => {
    const started = "2026-07-15T00:00:00.000Z";
    expect(remainingExecutionMs(started, 60_000, Date.parse(started) + 15_000)).toBe(45_000);
    expect(remainingExecutionMs(started, 60_000, Date.parse(started) + 70_000)).toBe(0);
  });
  test("streams the initial user message and returns the SDK terminal result", async () => {
    let initial: SDKUserMessage | undefined;
    let options: Options | undefined;
    const factory: SdkQueryFactory = ({ prompt, options: received }) => {
      options = received;
      return (async function* () {
        initial = (await prompt[Symbol.asyncIterator]().next()).value;
        yield result();
      })() as Query;
    };

    const executor = new ClaudeSdkExecutor({
      queryFactory: factory,
      claudeExecutable: "/home/ejclaw/.hermes/node/bin/claude",
      timeoutSeconds: 5,
    });
    const execution = await executor.run(request());

    expect(initial?.message).toEqual({ role: "user", content: "SDK TASK" });
    expect(options?.model).toBe("claude-fable-5");
    expect(options?.fallbackModel).toBe("gpt-5.6-sol");
    expect(options?.pathToClaudeCodeExecutable).toBe("/home/ejclaw/.hermes/node/bin/claude");
    expect(execution.ok).toBe(true);
    expect(execution.result).toBe("SDK_OK");
    expect(execution.sessionId).toBe("sdk-session");
  });

  test("applies live model and permission controls to the active SDK actor", async () => {
    let release!: () => void;
    let ready!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (ready = resolve));
    const models: Array<string | undefined> = [];
    const modes: string[] = [];

    const factory: SdkQueryFactory = ({ prompt }) => {
      const generator = (async function* () {
        await prompt[Symbol.asyncIterator]().next();
        ready();
        await released;
        yield result();
      })();
      return Object.assign(generator, {
        setModel: async (model?: string) => void models.push(model),
        setPermissionMode: async (mode: string) => void modes.push(mode),
        interrupt: async () => undefined,
        close: () => undefined,
      }) as Query;
    };

    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const running = executor.run(request());
    await started;
    expect(await executor.setModel("job-sdk", "gpt-5.6-sol")).toBe(true);
    expect(await executor.setPermissionMode("job-sdk", "manual")).toBe(true);
    expect(executor.steer("job-sdk", "SECOND TURN")).toBe(true);
    release();
    expect((await running).ok).toBe(true);
    expect(models).toEqual(["gpt-5.6-sol"]);
    expect(modes).toEqual(["default"]);
  });

  test("opens a resumed checkpoint-enabled SDK control session for rewind preview", async () => {
    let resume: string | undefined;
    let dryRun: boolean | undefined;
    let checkpoint = "";
    const factory: SdkQueryFactory = ({ options }) => {
      resume = options?.resume;
      const generator = (async function* () {})();
      return Object.assign(generator, {
        initializationResult: async () => ({}),
        rewindFiles: async (userMessageId: string, options?: { dryRun?: boolean }) => {
          checkpoint = userMessageId;
          dryRun = options?.dryRun;
          return { canRewind: true, filesChanged: ["src/a.ts"] };
        },
        close: () => undefined,
      }) as Query;
    };
    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const result = await executor.rewindSession("/tmp", "session-rewind", "checkpoint-1", true);
    expect(resume).toBe("session-rewind");
    expect(checkpoint).toBe("checkpoint-1");
    expect(dryRun).toBe(true);
    expect(result.filesChanged).toEqual(["src/a.ts"]);
  });

  test("routes SDK permission requests through the Discord approval hook", async () => {
    let permissionResult: Awaited<ReturnType<CanUseTool>> | undefined;
    let observedQuestion: InteractiveQuestion | undefined;
    const factory: SdkQueryFactory = ({ prompt, options }) =>
      (async function* () {
        await prompt[Symbol.asyncIterator]().next();
        permissionResult = await options?.canUseTool?.(
          "Bash",
          { command: "pwd" },
          { signal: new AbortController().signal, suggestions: [], toolUseID: "bash-1", requestId: "permission-1" },
        );
        yield result();
      })() as Query;
    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const execution = await executor.run(
      request({
        onQuestion: async (question) => {
          observedQuestion = question;
          return "이번만 허용";
        },
      }),
    );
    expect(execution.ok).toBe(true);
    expect(observedQuestion).toMatchObject({ kind: "permission", requestId: "permission-1" });
    expect(permissionResult).toMatchObject({ behavior: "allow", updatedInput: { command: "pwd" } });
  });

  test("answers native AskUserQuestion through the Discord question hook", async () => {
    let permissionResult: Awaited<ReturnType<CanUseTool>> | undefined;
    const observedRequestIds: string[] = [];
    const factory: SdkQueryFactory = ({ prompt, options }) =>
      (async function* () {
        await prompt[Symbol.asyncIterator]().next();
        permissionResult = await options?.canUseTool?.(
          "AskUserQuestion",
          {
            questions: [
              {
                question: "배포할까?",
                header: "배포",
                options: [
                  { label: "배포", description: "지금 배포" },
                  { label: "중단", description: "멈춤" },
                ],
                multiSelect: false,
              },
              {
                question: "환경은?",
                header: "환경",
                options: [
                  { label: "production", description: "운영" },
                  { label: "staging", description: "스테이징" },
                ],
                multiSelect: false,
              },
            ],
          },
          { signal: new AbortController().signal, suggestions: [], toolUseID: "ask-1", requestId: "request-1" },
        );
        yield result();
      })() as Query;

    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const execution = await executor.run(
      request({
        onQuestion: async (question) => {
          if (question.requestId) observedRequestIds.push(question.requestId);
          return question.choices?.[0] ?? "";
        },
      }),
    );

    expect(execution.ok).toBe(true);
    expect(observedRequestIds).toEqual(["request-1:0", "request-1:1"]);
    expect(permissionResult).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "배포할까?": "배포", "환경은?": "production" } },
    });
  });
});
