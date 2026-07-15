import { join } from "node:path";
import {
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type PermissionMode as SdkPermissionMode,
  type Query,
  type RewindFilesResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncMailbox } from "./async-mailbox";
import { markerContinuationPrompt, parseInteractiveQuestion } from "./interactive-control";
import { defaultAgents } from "./protocol";
import { finalizeStreamJsonResult, StreamProgressAggregator } from "./stream-progress";
import type { ClaudeExecution, ExecutionRequest, InteractiveQuestion, PermissionMode } from "./types";

export type SdkQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

interface SdkActor {
  query: Query;
  mailbox: AsyncMailbox<SDKUserMessage>;
  abortController: AbortController;
  onCheckpoint?: (userMessageId: string) => void;
}

interface SdkExecutorOptions {
  queryFactory?: SdkQueryFactory;
  claudeExecutable?: string;
  timeoutSeconds: number;
}

export interface SteeringMutationResult {
  mode: "replaced" | "corrected" | "removed" | "retracted";
  sdkMessageId: string;
}

type SdkUuid = NonNullable<SDKUserMessage["uuid"]>;

function sdkUserMessage(content: string, uuid: SdkUuid = crypto.randomUUID()): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid,
    timestamp: new Date().toISOString(),
  };
}

export function splitInitialSdkMessages(prompt: string): string[] {
  if (!prompt.startsWith("/goal ")) return [prompt];
  const newline = prompt.indexOf("\n");
  if (newline < 0) return [prompt];
  const command = prompt.slice(0, newline).trimEnd();
  const task = prompt.slice(newline + 1).trimStart();
  return task ? [command, task] : [command];
}

function normalizeLocalCommandFailure(execution: ClaudeExecution): ClaudeExecution {
  if (!execution.ok || !/^Goal condition is limited to \d+ characters \(got \d+\)$/m.test(execution.result.trim())) {
    return execution;
  }
  return {
    ...execution,
    ok: false,
    stderr: execution.stderr || execution.result,
    exitCode: execution.exitCode === 0 ? 1 : execution.exitCode,
  };
}

function normalizePermissionMode(mode: PermissionMode): SdkPermissionMode {
  return mode === "manual" ? "default" : mode;
}

export function remainingExecutionMs(startedAt: string | null, budgetMs: number, currentTime = Date.now()): number {
  if (!startedAt) return budgetMs;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return budgetMs;
  return Math.max(0, Math.min(budgetMs, started + budgetMs - currentTime));
}

function boundedInput(input: Record<string, unknown>): string {
  try {
    const encoded = JSON.stringify(input);
    return encoded.length > 900 ? `${encoded.slice(0, 897)}...` : encoded;
  } catch {
    return "(입력 직렬화 실패)";
  }
}

function askQuestionInput(input: Record<string, unknown>): Array<{
  question: string;
  choices: string[];
}> {
  if (!Array.isArray(input.questions)) return [];
  return input.questions.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const question = (candidate as { question?: unknown }).question;
    if (typeof question !== "string" || !question.trim()) return [];
    const rawOptions = (candidate as { options?: unknown }).options;
    const choices = Array.isArray(rawOptions)
      ? rawOptions.flatMap((option) => {
          if (!option || typeof option !== "object") return [];
          const label = (option as { label?: unknown }).label;
          return typeof label === "string" && label.trim() ? [label.trim()] : [];
        })
      : [];
    return [{ question: question.trim(), choices: choices.slice(0, 4) }];
  });
}

function missingSessionTranscript(execution: ClaudeExecution): boolean {
  return /no conversation found|session.*not found|conversation.*not found/i.test(
    `${execution.result}\n${execution.stderr}`,
  );
}

export class ClaudeSdkExecutor {
  private readonly queryFactory: SdkQueryFactory;
  private readonly claudeExecutable: string;
  private readonly timeoutMs: number;
  private readonly actors = new Map<string, SdkActor>();

  constructor(options: SdkExecutorOptions) {
    this.queryFactory = options.queryFactory ?? sdkQuery;
    const home = process.env.HOME;
    this.claudeExecutable =
      options.claudeExecutable ?? (home ? join(home, ".hermes/node/bin/claude") : "claude");
    this.timeoutMs = options.timeoutSeconds * 1000;
  }

  async run(request: ExecutionRequest): Promise<ClaudeExecution> {
    let execution = await this.runOnce(request, request.resume);
    if (request.resume && !execution.ok && missingSessionTranscript(execution)) {
      execution = await this.runOnce(request, false);
    }

    let markerTurn = request.continuationTurn ?? 0;
    while (true) {
      if (!execution.ok || !request.onQuestion) return execution;
      const parsed = parseInteractiveQuestion(execution.result);
      if (!parsed) return execution;
      if (markerTurn >= 4) {
        return {
          ...execution,
          ok: false,
          result: "interactive question continuation limit exceeded",
          stderr: "more than 4 marker questions in one job",
          exitCode: 1,
        };
      }
      const sessionId = execution.sessionId || request.sessionId;
      const nextTurn = markerTurn + 1;
      const question: InteractiveQuestion = {
        ...parsed,
        requestId: `marker:${request.job.id}:${markerTurn}`,
        kind: "question" as const,
        continuation: { sessionId, turn: nextTurn },
      };
      const answer = await request.onQuestion(question);
      const continuationPrompt = markerContinuationPrompt(question, answer);
      request.onContinuation?.(continuationPrompt, sessionId, nextTurn);
      execution = await this.runOnce(
        {
          ...request,
          prompt: continuationPrompt,
          sessionId,
          resume: true,
          forkSession: false,
          continuationTurn: nextTurn,
        },
        true,
      );
      markerTurn = nextTurn;
    }
  }

  private async runOnce(request: ExecutionRequest, resume: boolean): Promise<ClaudeExecution> {
    const mailbox = new AsyncMailbox<SDKUserMessage>();
    const abortController = new AbortController();
    const aggregator = new StreamProgressAggregator();
    const canUseTool = this.permissionHandler(request);
    let query: Query | undefined;
    let timedOut = false;
    let thrown: unknown;
    const timeoutBudget = remainingExecutionMs(request.job.startedAt, this.timeoutMs);
    if (timeoutBudget <= 0) {
      return {
        ok: false,
        result: "job timed out before retry could start",
        sessionId: request.sessionId,
        stderr: "absolute execution deadline exceeded",
        exitCode: 124,
      };
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort(new Error("job timed out"));
      mailbox.abort(new Error("job timed out"));
      if (query) {
        void query.interrupt().catch(() => undefined);
        (query as Query & { close?: () => void }).close?.();
      }
    }, timeoutBudget);
    timeout.unref();

    try {
      const permissionMode = normalizePermissionMode(request.route.permissionMode);
      const options: Options = {
        abortController,
        cwd: request.route.cwd,
        model: request.route.model,
        effort: request.route.effort,
        permissionMode,
        allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
        pathToClaudeCodeExecutable: this.claudeExecutable,
        tools: { type: "preset", preset: "claude_code" },
        systemPrompt: { type: "preset", preset: "claude_code" },
        includePartialMessages: true,
        includeHookEvents: true,
        forwardSubagentText: true,
        enableFileCheckpointing: true,
        ...(request.route.mixedAgents === false ? {} : { agents: defaultAgents }),
        canUseTool,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "eyejoker-native-claude/0.1.0" },
      };
      if (request.route.fallbackModel) options.fallbackModel = request.route.fallbackModel;
      if (resume) {
        options.resume = request.sessionId;
        if (request.forkSession !== undefined) options.forkSession = request.forkSession;
      } else {
        options.sessionId = request.sessionId;
      }
      query = this.queryFactory({ prompt: mailbox, options });
      const actor: SdkActor = { query, mailbox, abortController };
      if (request.onCheckpoint) actor.onCheckpoint = request.onCheckpoint;
      this.actors.set(request.job.id, actor);
      for (const content of splitInitialSdkMessages(request.prompt)) {
        const initialMessage = sdkUserMessage(content);
        if (initialMessage.uuid) request.onCheckpoint?.(initialMessage.uuid);
        mailbox.push(initialMessage);
      }

      for await (const message of query) {
        request.onHeartbeat?.();
        const event = aggregator.ingestLine(JSON.stringify(message satisfies SDKMessage));
        if (event) request.onProgress?.(event, aggregator);
        if (message.type === "result") mailbox.close();
      }
    } catch (error) {
      thrown = error;
    } finally {
      clearTimeout(timeout);
      this.actors.delete(request.job.id);
      mailbox.close();
      (query as (Query & { close?: () => void }) | undefined)?.close?.();
    }

    const errorText = timedOut
      ? "job timed out"
      : thrown instanceof Error
        ? thrown.message
        : thrown === undefined
          ? ""
          : String(thrown);
    return normalizeLocalCommandFailure(
      finalizeStreamJsonResult(aggregator, "", errorText, timedOut ? 124 : thrown !== undefined ? 1 : 0),
    );
  }

  steer(jobId: string, content: string, userMessageId: string = crypto.randomUUID()): boolean {
    const actor = this.actors.get(jobId);
    if (!actor) return false;
    const message = sdkUserMessage(content, userMessageId as SdkUuid);
    const accepted = actor.mailbox.push(message);
    if (accepted && message.uuid) actor.onCheckpoint?.(message.uuid);
    return accepted;
  }

  editSteering(
    jobId: string,
    userMessageId: string,
    content: string,
    logicalMessageId?: string,
    originalUserMessageId: string = userMessageId,
  ): SteeringMutationResult | null {
    const actor = this.actors.get(jobId);
    if (!actor) return null;
    const replacement = sdkUserMessage(content, userMessageId as SdkUuid);
    if (actor.mailbox.replace((message) => message.uuid === userMessageId, replacement)) {
      return { mode: "replaced", sdkMessageId: userMessageId };
    }
    const correction = sdkUserMessage(
      [
        "[Discord 추가 지시 수정]",
        logicalMessageId ? `Discord message ${logicalMessageId}의 현재 지시 상태야.` : "Discord 추가 지시의 현재 상태야.",
        `원본 SDK user message: ${originalUserMessageId}`,
        `직전 SDK user message: ${userMessageId}`,
        "이전 원본과 모든 수정본 대신 아래 최신 지시만 따라.",
        "",
        content,
      ].join("\n"),
    );
    if (!actor.mailbox.push(correction) || !correction.uuid) return null;
    actor.onCheckpoint?.(correction.uuid);
    return { mode: "corrected", sdkMessageId: correction.uuid };
  }

  deleteSteering(
    jobId: string,
    userMessageId: string,
    logicalMessageId?: string,
    originalUserMessageId: string = userMessageId,
  ): SteeringMutationResult | null {
    const actor = this.actors.get(jobId);
    if (!actor) return null;
    const removedCurrent = actor.mailbox.remove((message) => message.uuid === userMessageId);
    const removedOriginal =
      originalUserMessageId === userMessageId
        ? removedCurrent
        : actor.mailbox.remove((message) => message.uuid === originalUserMessageId);
    if (originalUserMessageId === userMessageId && removedOriginal) {
      return { mode: "removed", sdkMessageId: userMessageId };
    }
    const retraction = sdkUserMessage(
      [
        "[Discord 추가 지시 철회]",
        logicalMessageId
          ? `Discord message ${logicalMessageId}의 원본 및 모든 수정 지시를 사용자가 삭제했어.`
          : "Discord 추가 지시의 원본 및 모든 수정 지시를 사용자가 삭제했어.",
        `원본 SDK user message: ${originalUserMessageId}`,
        `직전 SDK user message: ${userMessageId}`,
        "해당 logical message의 어떤 버전도 더 이상 따르지 마. 이미 발생한 외부 side effect를 임의로 되돌리지는 말고 최종 결과에 알려.",
      ].join("\n"),
    );
    if (!actor.mailbox.push(retraction) || !retraction.uuid) return null;
    actor.onCheckpoint?.(retraction.uuid);
    return { mode: "retracted", sdkMessageId: retraction.uuid };
  }

  cancel(jobId: string): boolean {
    const actor = this.actors.get(jobId);
    if (!actor) return false;
    actor.abortController.abort(new Error("job cancelled"));
    actor.mailbox.abort(new Error("job cancelled"));
    void actor.query.interrupt().catch(() => undefined);
    actor.query.close();
    return true;
  }

  async setModel(jobId: string, model?: string): Promise<boolean> {
    const actor = this.actors.get(jobId);
    if (!actor) return false;
    await actor.query.setModel(model);
    return true;
  }

  async setPermissionMode(jobId: string, mode: PermissionMode): Promise<boolean> {
    const actor = this.actors.get(jobId);
    if (!actor) return false;
    await actor.query.setPermissionMode(normalizePermissionMode(mode));
    return true;
  }

  async rewindFiles(jobId: string, userMessageId: string, dryRun: boolean) {
    const actor = this.actors.get(jobId);
    if (!actor) return null;
    return actor.query.rewindFiles(userMessageId, { dryRun });
  }

  async rewindSession(
    cwd: string,
    sessionId: string,
    userMessageId: string,
    dryRun: boolean,
  ): Promise<RewindFilesResult> {
    const mailbox = new AsyncMailbox<SDKUserMessage>();
    const abortController = new AbortController();
    const query = this.queryFactory({
      prompt: mailbox,
      options: {
        abortController,
        cwd,
        resume: sessionId,
        enableFileCheckpointing: true,
        pathToClaudeCodeExecutable: this.claudeExecutable,
        tools: { type: "preset", preset: "claude_code" },
        systemPrompt: { type: "preset", preset: "claude_code" },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "eyejoker-native-claude/0.1.0" },
      },
    });
    const timeout = setTimeout(() => {
      abortController.abort(new Error("rewind control timed out"));
      query.close();
    }, Math.min(this.timeoutMs, 60_000));
    timeout.unref();
    try {
      await query.initializationResult();
      return await query.rewindFiles(userMessageId, { dryRun });
    } finally {
      clearTimeout(timeout);
      mailbox.close();
      query.close();
    }
  }

  private permissionHandler(request: ExecutionRequest): CanUseTool {
    return async (toolName, input, context) => {
      if (toolName === "AskUserQuestion") {
        const parsedQuestions = askQuestionInput(input);
        const questions = parsedQuestions.map((question, index) => ({
          ...question,
          requestId:
            parsedQuestions.length > 1 ? `${context.toolUseID}:${index}` : context.toolUseID,
          kind: "question" as const,
        }));
        if (questions.length === 0 || !request.onQuestion) {
          return { behavior: "deny", message: "Discord에서 처리할 수 없는 질문 형식" };
        }
        const answers: Record<string, string> = {};
        for (const question of questions) {
          answers[question.question] = await request.onQuestion(question);
        }
        return { behavior: "allow", updatedInput: { ...input, answers } };
      }

      if (!request.onQuestion) {
        return { behavior: "deny", message: "Discord permission handler가 없음" };
      }
      const prompt: InteractiveQuestion = {
        question: `${toolName} 실행을 허용할까?\n${boundedInput(input)}`,
        choices: ["이번만 허용", "거부"],
        requestId: context.toolUseID,
        kind: "permission",
      };
      const answer = await request.onQuestion(prompt);
      return answer === "이번만 허용"
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "사용자가 거부함" };
    };
  }
}
