import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildClaudeInvocation } from "./protocol";
import { finalizeStreamJsonResult, StreamProgressAggregator, type ProgressEvent } from "./stream-progress";
import { parseInteractiveQuestion, streamUserEvent } from "./interactive-control";
import type { ClaudeExecution, ExecutionRequest } from "./types";

interface ExecutorOptions {
  binary?: string;
  timeoutSeconds: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

export class ClaudeProcessExecutor {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly children = new Map<string, ChildProcess>();

  constructor(options: ExecutorOptions) {
    this.binary = options.binary ?? "claude";
    this.timeoutMs = options.timeoutSeconds * 1000;
    this.maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    this.killGraceMs = options.killGraceMs ?? 5_000;
  }

  async run(request: ExecutionRequest): Promise<ClaudeExecution> {
    const first = await this.runOnce(request, request.resume);
    if (
      request.resume &&
      !first.ok &&
      /no conversation found|session.*not found|conversation.*not found/i.test(`${first.result}\n${first.stderr}`)
    ) {
      return this.runOnce(request, false);
    }
    return first;
  }

  steer(jobId: string, content: string): boolean {
    const child = this.children.get(jobId);
    return child ? this.writeUser(child, content) : false;
  }

  cancel(jobId: string): boolean {
    const child = this.children.get(jobId);
    if (!child) return false;
    this.terminate(child);
    return true;
  }

  private writeUser(child: ChildProcess, content: string): boolean {
    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) return false;
    try {
      child.stdin.write(streamUserEvent(content));
      return true;
    } catch {
      return false;
    }
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall back to the direct child when the process group has already gone.
      }
    }
    child.kill(signal);
  }

  private terminate(child: ChildProcess): void {
    this.signal(child, "SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) this.signal(child, "SIGKILL");
    }, this.killGraceMs).unref();
  }

  private runOnce(request: ExecutionRequest, resume: boolean): Promise<ClaudeExecution> {
    return new Promise((resolve) => {
      const invocation = buildClaudeInvocation(
        request.route,
        request.prompt,
        request.sessionId,
        resume,
        resume && request.forkSession === true,
      );
      const child = spawn(this.binary, invocation.args, {
        cwd: request.route.cwd,
        env: { ...process.env, ...invocation.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      this.children.set(request.job.id, child);

      let stdout = "";
      let stderr = "";
      let lineBuffer = "";
      const aggregator = new StreamProgressAggregator();
      const stdoutDecoder = new StringDecoder("utf8");
      const append = (current: string, value: Buffer | string): string => {
        if (Buffer.byteLength(current) >= this.maxOutputBytes) return current;
        const text = typeof value === "string" ? value : value.toString();
        return (current + text).slice(0, this.maxOutputBytes);
      };

      let questionInFlight = false;
      const emitProgress = (event: ProgressEvent | null): void => {
        if (!event || !request.onProgress) return;
        try {
          request.onProgress(event, aggregator);
        } catch (error) {
          console.warn("onProgress failed", error);
        }
      };

      const ingestLine = (line: string): void => {
        const event = aggregator.ingestLine(line);
        emitProgress(event);
        if (event?.kind !== "result" || questionInFlight) return;
        const question = parseInteractiveQuestion(event.finalResult ?? "");
        if (!question || !request.onQuestion) {
          child.stdin?.end();
          return;
        }
        questionInFlight = true;
        void request
          .onQuestion(question)
          .then((answer) => {
            questionInFlight = false;
            if (!this.writeUser(child, `[Discord 질문 답변]\n${answer}`)) {
              throw new Error("Claude stdin closed before question answer");
            }
          })
          .catch((error) => {
            stderr += `\nquestion bridge failed: ${error instanceof Error ? error.message : String(error)}`;
            child.stdin?.end();
          });
      };

      child.stdout.on("data", (data: Buffer) => {
        const text = stdoutDecoder.write(data);
        stdout = append(stdout, text);
        lineBuffer += text;
        let newline = lineBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = lineBuffer.slice(0, newline);
          lineBuffer = lineBuffer.slice(newline + 1);
          ingestLine(line);
          newline = lineBuffer.indexOf("\n");
        }
        request.onHeartbeat?.();
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = append(stderr, data);
        request.onHeartbeat?.();
      });

      if (!this.writeUser(child, request.prompt)) {
        stderr += "\nfailed to write initial Claude user event";
        child.stdin?.end();
      }
      if (child.pid && request.onSpawn) request.onSpawn(child.pid);

      const heartbeat = setInterval(() => request.onHeartbeat?.(), 10_000);
      heartbeat.unref();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        this.terminate(child);
      }, this.timeoutMs);
      timeout.unref();

      child.once("error", (error) => {
        stderr += `\n${error.message}`;
      });
      child.once("close", (code) => {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        this.children.delete(request.job.id);
        const decoderTail = stdoutDecoder.end();
        if (decoderTail) {
          stdout = append(stdout, decoderTail);
          lineBuffer += decoderTail;
        }
        if (lineBuffer.trim()) ingestLine(lineBuffer);
        const exitCode = timedOut ? 124 : (code ?? 1);
        const parsed = finalizeStreamJsonResult(
          aggregator,
          stdout,
          timedOut ? `${stderr}\njob timed out` : stderr,
          exitCode,
        );
        if (!parsed.sessionId) parsed.sessionId = aggregator.sessionId || request.sessionId;
        resolve(parsed);
      });
    });
  }
}
