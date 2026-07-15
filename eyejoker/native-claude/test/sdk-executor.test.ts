import { describe, expect, test } from "bun:test";
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSdkExecutor,
  remainingExecutionMs,
  splitInitialSdkMessages,
  type SdkQueryFactory,
} from "../src/sdk-executor";
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
      pinnedSession: false,
      githubWatchRepo: null,
      githubWatchNumber: null,
      expectedHeadSha: null,
      attempts: 1,
      startedBefore: false,
      recoveryReason: null,
      continuationPrompt: null,
      continuationSessionId: null,
      continuationTurn: 0,
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
    stop_reason: null,
    session_id: sessionId,
    total_cost_usd: 0,
    usage: {} as never,
    modelUsage: {},
    permission_denials: [],
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
    expect(options?.agents?.["fable-worker"]?.model).toBe("claude-fable-5");
    expect(options?.agents?.["gpt-worker"]?.model).toBe("gpt-5.6-sol");
    expect(options?.pathToClaudeCodeExecutable).toBe("/home/ejclaw/.hermes/node/bin/claude");
    expect(execution.ok).toBe(true);
    expect(execution.result).toBe("SDK_OK");
    expect(execution.sessionId).toBe("sdk-session");
  });

  test("streams a long autonomous goal command and task as separate SDK user messages", async () => {
    const task = `사용자 요청:\n${"긴 Discord context와 요청 ".repeat(220)}`;
    const autonomousPrompt = `/goal 짧고 검증 가능한 완료 조건\n\n${task}`;
    const messages: SDKUserMessage[] = [];
    const checkpoints: string[] = [];
    const factory: SdkQueryFactory = ({ prompt }) =>
      (async function* () {
        const iterator = prompt[Symbol.asyncIterator]();
        messages.push((await iterator.next()).value!);
        messages.push((await iterator.next()).value!);
        yield result();
      })() as Query;
    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const execution = await executor.run(
      request({ prompt: autonomousPrompt, onCheckpoint: (userMessageId) => checkpoints.push(userMessageId) }),
    );

    expect(execution.ok).toBe(true);
    expect(splitInitialSdkMessages(autonomousPrompt)).toEqual(["/goal 짧고 검증 가능한 완료 조건", task]);
    expect(messages.map((message) => message.message.content)).toEqual([
      "/goal 짧고 검증 가능한 완료 조건",
      task,
    ]);
    expect(String(messages[0]?.message.content).length).toBeLessThan(4_000);
    expect(String(messages[1]?.message.content).length).toBeGreaterThan(4_000);
    expect(checkpoints).toHaveLength(2);
  });

  test("fails closed when a local goal command error arrives as an SDK success result", async () => {
    const factory: SdkQueryFactory = ({ prompt }) =>
      (async function* () {
        await prompt[Symbol.asyncIterator]().next();
        yield { ...result(), result: "Goal condition is limited to 4000 characters (got 4518)" };
      })() as Query;
    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const execution = await executor.run(request());

    expect(execution.ok).toBe(false);
    expect(execution.exitCode).toBe(1);
    expect(execution.stderr).toContain("Goal condition is limited to 4000 characters");
  });

  test("falls back to the same session id when a recovered SDK transcript is missing", async () => {
    const calls: Options[] = [];
    const factory: SdkQueryFactory = ({ prompt, options }) => {
      calls.push(options ?? {});
      return (async function* () {
        await prompt[Symbol.asyncIterator]().next();
        if (options?.resume) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: true,
            num_turns: 0,
            stop_reason: null,
            total_cost_usd: 0,
            usage: {} as never,
            modelUsage: {},
            permission_denials: [],
            errors: [`No conversation found with session ID: ${options.resume}`],
            uuid: crypto.randomUUID(),
            session_id: options.resume,
          } satisfies SDKMessage;
          return;
        }
        yield result(options?.sessionId);
      })() as Query;
    };
    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const execution = await executor.run(request({ resume: true }));

    expect(execution.ok).toBe(true);
    expect(execution.result).toBe("SDK_OK");
    expect(execution.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.resume).toBe("11111111-1111-4111-8111-111111111111");
    expect(calls[1]?.resume).toBeUndefined();
    expect(calls[1]?.sessionId).toBe("11111111-1111-4111-8111-111111111111");
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

  test("corrects and retracts already-consumed follow-up steering inputs", async () => {
    const observed: SDKUserMessage[] = [];
    let actorReady!: () => void;
    let steeringConsumed!: () => void;
    let correctionConsumed!: () => void;
    const actorReadyPromise = new Promise<void>((resolve) => (actorReady = resolve));
    const steeringConsumedPromise = new Promise<void>((resolve) => (steeringConsumed = resolve));
    const correctionConsumedPromise = new Promise<void>((resolve) => (correctionConsumed = resolve));
    const factory: SdkQueryFactory = ({ prompt }) =>
      (async function* () {
        const iterator = prompt[Symbol.asyncIterator]();
        observed.push((await iterator.next()).value!);
        actorReady();
        observed.push((await iterator.next()).value!);
        steeringConsumed();
        observed.push((await iterator.next()).value!);
        correctionConsumed();
        observed.push((await iterator.next()).value!);
        yield result();
      })() as Query;
    const checkpoints: string[] = [];
    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const executionPromise = executor.run(
      request({ onCheckpoint: (messageId) => checkpoints.push(messageId) }),
    );
    await actorReadyPromise;

    const steeringId = crypto.randomUUID();
    expect(executor.steer("job-sdk", "첫 추가 지시", steeringId)).toBe(true);
    await steeringConsumedPromise;
    const edit = executor.editSteering("job-sdk", steeringId, "수정된 추가 지시");
    expect(edit?.mode).toBe("corrected");
    await correctionConsumedPromise;
    const deletion = executor.deleteSteering("job-sdk", edit!.sdkMessageId, "discord-followup-1", steeringId);
    expect(deletion?.mode).toBe("retracted");

    expect((await executionPromise).ok).toBe(true);
    expect(String(observed[1]?.message.content)).toBe("첫 추가 지시");
    expect(String(observed[2]?.message.content)).toContain("수정된 추가 지시");
    expect(String(observed[3]?.message.content)).toContain("원본 및 모든 수정 지시를 사용자가 삭제했어");
    expect(String(observed[3]?.message.content)).toContain("discord-followup-1");
    expect(String(observed[3]?.message.content)).toContain(steeringId);
    expect(checkpoints).toContain(steeringId);
    expect(checkpoints).toContain(edit!.sdkMessageId);
    expect(checkpoints).toContain(deletion!.sdkMessageId);
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
    expect(observedQuestion).toMatchObject({ kind: "permission", requestId: "bash-1" });
    expect(permissionResult).toMatchObject({ behavior: "allow", updatedInput: { command: "pwd" } });
  });

  test("continues a marker fallback question in the same SDK session", async () => {
    const prompts: string[] = [];
    const optionsSeen: Options[] = [];
    const observed: InteractiveQuestion[] = [];
    let call = 0;
    const factory: SdkQueryFactory = ({ prompt, options }) => {
      optionsSeen.push(options ?? {});
      return (async function* () {
        prompts.push(String((await prompt[Symbol.asyncIterator]().next()).value?.message.content));
        call += 1;
        if (call === 1) {
          yield {
            ...result("marker-session"),
            result:
              '선택이 필요해.\nDISCORD_QUESTION:{"question":"배포할까?","choices":["배포","중단"]}',
          };
          return;
        }
        yield { ...result("marker-session"), result: "MARKER_CONTINUED_OK" };
      })() as Query;
    };
    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const execution = await executor.run(
      request({
        onQuestion: async (question) => {
          observed.push(question);
          return "배포";
        },
      }),
    );

    expect(execution.ok).toBe(true);
    expect(execution.result).toBe("MARKER_CONTINUED_OK");
    expect(observed).toEqual([
      expect.objectContaining({ question: "배포할까?", choices: ["배포", "중단"], kind: "question" }),
    ]);
    expect(optionsSeen).toHaveLength(2);
    expect(optionsSeen[1]?.resume).toBe("marker-session");
    expect(prompts[1]).toContain("배포");
  });

  test("allows a normal final result after exactly four marker answers", async () => {
    let calls = 0;
    const factory: SdkQueryFactory = ({ prompt }) =>
      (async function* () {
        await prompt[Symbol.asyncIterator]().next();
        calls += 1;
        yield {
          ...result("four-marker-session"),
          result:
            calls <= 4
              ? `DISCORD_QUESTION:{"question":"선택 ${calls}?","choices":["계속","중단"]}`
              : "FOUR_MARKERS_FINAL_OK",
        };
      })() as Query;
    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const execution = await executor.run(request({ onQuestion: async () => "계속" }));

    expect(calls).toBe(5);
    expect(execution).toMatchObject({ ok: true, result: "FOUR_MARKERS_FINAL_OK" });
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
    expect(observedRequestIds).toEqual(["ask-1:0", "ask-1:1"]);
    expect(permissionResult).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "배포할까?": "배포", "환경은?": "production" } },
    });
  });

  test("resets native question progress even when its SDK events arrive after the answer callback", async () => {
    const toolSnapshots: string[][] = [];
    const factory: SdkQueryFactory = ({ prompt, options }) =>
      (async function* () {
        await prompt[Symbol.asyncIterator]().next();
        await options?.canUseTool?.(
          "AskUserQuestion",
          {
            questions: [
              {
                question: "계속할까?",
                options: [{ label: "계속" }, { label: "중단" }],
                multiSelect: false,
              },
            ],
          },
          { signal: new AbortController().signal, suggestions: [], toolUseID: "ask-late", requestId: "request-late" },
        );
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            model: "claude-fable-5",
            content: [{ type: "tool_use", id: "ask-late", name: "AskUserQuestion", input: {} }],
          },
          session_id: "late-session",
        };
        yield {
          type: "user",
          parent_tool_use_id: null,
          message: { content: [{ type: "tool_result", tool_use_id: "ask-late", content: "계속", is_error: false }] },
          session_id: "late-session",
        };
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            model: "claude-fable-5",
            content: [{ type: "tool_use", id: "bash-after", name: "Bash", input: { command: "echo AFTER" } }],
          },
          session_id: "late-session",
        };
        yield result("late-session");
      })() as Query;
    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const execution = await executor.run(
      request({
        onQuestion: async () => "계속",
        onProgress: (_event, aggregator) => {
          toolSnapshots.push(aggregator.snapshot().tools.map((tool) => tool.name));
        },
      }),
    );

    expect(execution.ok).toBe(true);
    expect(toolSnapshots.some((tools) => tools.includes("Bash"))).toBe(true);
    expect(toolSnapshots.every((tools) => !tools.includes("AskUserQuestion"))).toBe(true);
  });

  test("fails closed instead of flattening native multi-select questions", async () => {
    let permissionResult: Awaited<ReturnType<CanUseTool>> | undefined;
    let questionCalls = 0;
    const factory: SdkQueryFactory = ({ prompt, options }) =>
      (async function* () {
        await prompt[Symbol.asyncIterator]().next();
        permissionResult = await options?.canUseTool?.(
          "AskUserQuestion",
          {
            questions: [
              {
                question: "여러 개 고를까?",
                options: [{ label: "A" }, { label: "B" }],
                multiSelect: true,
              },
            ],
          },
          { signal: new AbortController().signal, suggestions: [], toolUseID: "ask-multi", requestId: "request-multi" },
        );
        yield result();
      })() as Query;
    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const execution = await executor.run(
      request({
        onQuestion: async () => {
          questionCalls += 1;
          return "A";
        },
      }),
    );

    expect(execution.ok).toBe(true);
    expect(questionCalls).toBe(0);
    expect(permissionResult).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("다중 선택"),
    });
  });

  test("fails closed when native questions cannot render one to four buttons", async () => {
    const permissionResults: Array<Exclude<Awaited<ReturnType<CanUseTool>>, null | undefined>> = [];
    let questionCalls = 0;
    const factory: SdkQueryFactory = ({ prompt, options }) =>
      (async function* () {
        await prompt[Symbol.asyncIterator]().next();
        for (const optionCount of [0, 5]) {
          const response = await options?.canUseTool?.(
            "AskUserQuestion",
            {
              questions: [
                {
                  question: `선택지 ${optionCount}개`,
                  options: Array.from({ length: optionCount }, (_, index) => ({ label: `선택 ${index + 1}` })),
                  multiSelect: false,
                },
              ],
            },
            {
              signal: new AbortController().signal,
              suggestions: [],
              toolUseID: `ask-options-${optionCount}`,
              requestId: `request-options-${optionCount}`,
            },
          );
          if (response) permissionResults.push(response);
        }
        yield result();
      })() as Query;
    const executor = new ClaudeSdkExecutor({ queryFactory: factory, timeoutSeconds: 5 });
    const execution = await executor.run(
      request({
        onQuestion: async () => {
          questionCalls += 1;
          return "선택 1";
        },
      }),
    );

    expect(execution.ok).toBe(true);
    expect(questionCalls).toBe(0);
    expect(permissionResults).toHaveLength(2);
    expect(permissionResults.every((response) => response.behavior === "deny")).toBe(true);
  });
});
