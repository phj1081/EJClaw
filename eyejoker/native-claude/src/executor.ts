import { spawn, type ChildProcess } from "node:child_process";
import { buildClaudeInvocation, parseClaudeOutput } from "./protocol";
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

  cancel(jobId: string): boolean {
    const child = this.children.get(jobId);
    if (!child) return false;
    this.terminate(child);
    return true;
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
      const invocation = buildClaudeInvocation(request.route, request.prompt, request.sessionId, resume);
      const child = spawn(this.binary, invocation.args, {
        cwd: request.route.cwd,
        env: { ...process.env, ...invocation.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      this.children.set(request.job.id, child);
      if (child.pid && request.onSpawn) request.onSpawn(child.pid);

      let stdout = "";
      let stderr = "";
      const append = (current: string, value: Buffer): string => {
        if (Buffer.byteLength(current) >= this.maxOutputBytes) return current;
        return (current + value.toString()).slice(0, this.maxOutputBytes);
      };
      child.stdout.on("data", (data: Buffer) => {
        stdout = append(stdout, data);
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = append(stderr, data);
      });

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
        const exitCode = timedOut ? 124 : (code ?? 1);
        const parsed = parseClaudeOutput(stdout, timedOut ? `${stderr}\njob timed out` : stderr, exitCode);
        if (!parsed.sessionId) parsed.sessionId = request.sessionId;
        resolve(parsed);
      });
    });
  }
}
