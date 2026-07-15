import { formatElapsedKorean } from "./duration";
import { shortModelLabel } from "./model-visibility";

export type ProgressPhase =
  | "starting"
  | "thinking"
  | "tool"
  | "tool_result"
  | "writing"
  | "completed"
  | "failed"
  | "cancelled";

export interface ProgressEvent {
  kind:
    | "status"
    | "thinking"
    | "tool_start"
    | "tool_input"
    | "tool_result"
    | "text"
    | "result"
    | "system";
  phase: ProgressPhase;
  summary: string;
  detail?: string;
  toolName?: string;
  toolId?: string;
  textDelta?: string;
  sessionId?: string;
  isError?: boolean;
  finalResult?: string;
  at: number;
}

export interface TimelineEntry {
  at: number;
  kind: ProgressEvent["kind"];
  text: string;
}

export interface ProgressTool {
  id: string;
  name: string;
  input: string;
  agentId: string;
  result?: string;
  error?: boolean;
}

export interface SubagentProgress {
  id: string;
  label: string;
  model: string;
  done: boolean;
  lastActivity: string;
}

export interface ProgressSnapshot {
  phase: ProgressPhase;
  statusLabel: string;
  currentActivity: string;
  liveText: string;
  timeline: TimelineEntry[];
  tools: ProgressTool[];
  mainModel: string;
  modelTransition: string;
  subagents: SubagentProgress[];
  sessionId: string;
  numTurns: number | null;
  costUsd: number | null;
  finalResult: string;
  isError: boolean;
  eventCount: number;
  dirty: boolean;
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (name === "Bash" && typeof obj.command === "string") {
    const desc = typeof obj.description === "string" ? ` — ${obj.description}` : "";
    return truncate(`${obj.command}${desc}`, 160);
  }
  if (typeof obj.file_path === "string") return truncate(String(obj.file_path), 160);
  if (typeof obj.path === "string") return truncate(String(obj.path), 160);
  if (typeof obj.pattern === "string") return truncate(String(obj.pattern), 160);
  if (typeof obj.query === "string") return truncate(String(obj.query), 160);
  try {
    return truncate(JSON.stringify(obj), 160);
  } catch {
    return "";
  }
}

export class StreamProgressAggregator {
  phase: ProgressPhase = "starting";
  statusLabel = "시작 중";
  currentActivity = "Claude 세션 준비";
  liveText = "";
  timeline: TimelineEntry[] = [];
  tools = new Map<string, ProgressTool>();
  mainModel = "";
  modelTransition = "";
  subagents = new Map<string, SubagentProgress>();
  sessionId = "";
  numTurns: number | null = null;
  costUsd: number | null = null;
  finalResult = "";
  isError = false;
  eventCount = 0;
  dirty = false;

  private openToolId: string | null = null;
  private toolJsonBuffer = new Map<string, string>();
  private lastTimelineKey = "";

  private markDirty(): void {
    this.dirty = true;
  }

  consumeDirty(): boolean {
    const value = this.dirty;
    this.dirty = false;
    return value;
  }

  private observeModel(agentId: string, model: string): void {
    if (!model) return;
    if (agentId === "main") {
      if (this.mainModel && this.mainModel !== model) {
        this.modelTransition = `${shortModelLabel(this.mainModel)} → ${shortModelLabel(model)}`;
      }
      this.mainModel = model;
      return;
    }
    const track = this.subagents.get(agentId) ?? {
      id: agentId,
      label: "작업 중...",
      model: "",
      done: false,
      lastActivity: "",
    };
    track.model = model;
    this.subagents.set(agentId, track);
  }

  private ensureSubagent(id: string, input: unknown): SubagentProgress {
    const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const label =
      (typeof obj.description === "string" && truncate(obj.description, 40)) ||
      (typeof obj.prompt === "string" && truncate(obj.prompt, 40)) ||
      this.subagents.get(id)?.label ||
      "작업 중...";
    const track = this.subagents.get(id) ?? {
      id,
      label,
      model: "",
      done: false,
      lastActivity: "",
    };
    track.label = label;
    this.subagents.set(id, track);
    return track;
  }

  private updateSubagentActivity(agentId: string, activity: string): void {
    if (agentId === "main") return;
    const track = this.subagents.get(agentId) ?? this.ensureSubagent(agentId, null);
    track.lastActivity = truncate(activity, 100);
  }

  private pushTimeline(kind: ProgressEvent["kind"], text: string, at = Date.now()): void {
    const key = `${kind}:${text}`;
    if (key === this.lastTimelineKey) return;
    this.lastTimelineKey = key;
    this.timeline.push({ at, kind, text: truncate(text, 180) });
    if (this.timeline.length > 12) this.timeline = this.timeline.slice(-12);
  }

  private emit(
    event: Omit<ProgressEvent, "sessionId"> & { sessionId?: string | undefined },
  ): ProgressEvent {
    this.eventCount += 1;
    this.phase = event.phase;
    if (event.summary) this.currentActivity = event.summary;
    if (event.sessionId) this.sessionId = event.sessionId;
    this.markDirty();
    const normalized: ProgressEvent = {
      kind: event.kind,
      phase: event.phase,
      summary: event.summary,
      at: event.at,
    };
    if (event.detail !== undefined) normalized.detail = event.detail;
    if (event.toolName !== undefined) normalized.toolName = event.toolName;
    if (event.toolId !== undefined) normalized.toolId = event.toolId;
    if (event.textDelta !== undefined) normalized.textDelta = event.textDelta;
    if (event.sessionId !== undefined) normalized.sessionId = event.sessionId;
    if (event.isError !== undefined) normalized.isError = event.isError;
    if (event.finalResult !== undefined) normalized.finalResult = event.finalResult;
    return normalized;
  }

  ingestLine(line: string): ProgressEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return null;
    }
    return this.ingestObject(obj);
  }

  ingestObject(obj: Record<string, unknown>): ProgressEvent | null {
    const type = String(obj.type ?? "");
    const sessionId = typeof obj.session_id === "string" ? obj.session_id : undefined;
    if (sessionId) this.sessionId = sessionId;
    const parentToolUseId = typeof obj.parent_tool_use_id === "string" ? obj.parent_tool_use_id : null;
    const agentId = parentToolUseId ?? "main";
    const at = Date.now();

    if (type === "system") {
      const subtype = String(obj.subtype ?? "");
      if (subtype === "init") {
        if (typeof obj.model === "string") this.observeModel("main", obj.model);
        this.statusLabel = "초기화";
        this.pushTimeline("system", "세션 초기화", at);
        return this.emit({
          kind: "system",
          phase: "starting",
          summary: "세션 초기화 완료",
          sessionId,
          at,
        });
      }
      if (subtype === "status") {
        const status = String(obj.status ?? "working");
        this.statusLabel = status;
        const phase: ProgressPhase =
          status === "requesting" || status === "thinking" ? "thinking" : status === "tool" ? "tool" : "writing";
        this.pushTimeline("status", `status=${status}`, at);
        return this.emit({
          kind: "status",
          phase,
          summary: `Claude ${status}`,
          sessionId,
          at,
        });
      }
      if (subtype === "hook_started") {
        const name = String(obj.hook_name ?? obj.hook_event ?? "hook");
        return this.emit({
          kind: "system",
          phase: this.phase === "starting" ? "starting" : this.phase,
          summary: `hook ${name}`,
          detail: name,
          sessionId,
          at,
        });
      }
      return null;
    }

    if (type === "stream_event") {
      const event = (obj.event ?? {}) as Record<string, unknown>;
      const eventType = String(event.type ?? "");
      if (eventType === "content_block_start") {
        const block = (event.content_block ?? {}) as Record<string, unknown>;
        const blockType = String(block.type ?? "");
        if (blockType === "thinking") {
          this.pushTimeline("thinking", "thinking 시작", at);
          return this.emit({
            kind: "thinking",
            phase: "thinking",
            summary: "생각 중",
            sessionId,
            at,
          });
        }
        if (blockType === "tool_use") {
          const id = String(block.id ?? `tool-${this.tools.size + 1}`);
          const name = String(block.name ?? "tool");
          this.openToolId = id;
          this.toolJsonBuffer.set(id, "");
          this.tools.set(id, { id, name, input: "", agentId });
          this.pushTimeline("tool_start", `🔧 ${name}`, at);
          return this.emit({
            kind: "tool_start",
            phase: "tool",
            summary: `도구 실행: ${name}`,
            toolName: name,
            toolId: id,
            sessionId,
            at,
          });
        }
        if (blockType === "text") {
          return this.emit({
            kind: "text",
            phase: "writing",
            summary: "응답 작성 중",
            sessionId,
            at,
          });
        }
      }
      if (eventType === "content_block_delta") {
        const delta = (event.delta ?? {}) as Record<string, unknown>;
        const deltaType = String(delta.type ?? "");
        if (deltaType === "thinking_delta") {
          const thinking = String(delta.thinking ?? "");
          if (!thinking) return null;
          return this.emit({
            kind: "thinking",
            phase: "thinking",
            summary: "생각 중",
            detail: truncate(thinking, 120),
            textDelta: thinking,
            sessionId,
            at,
          });
        }
        if (deltaType === "text_delta") {
          const text = String(delta.text ?? "");
          if (!text) return null;
          if (agentId === "main") this.liveText = `${this.liveText}${text}`.slice(-4000);
          else this.updateSubagentActivity(agentId, `💬 ${text}`);
          return this.emit({
            kind: "text",
            phase: "writing",
            summary: "응답 스트리밍",
            textDelta: text,
            sessionId,
            at,
          });
        }
        if (deltaType === "input_json_delta" && this.openToolId) {
          const partial = String(delta.partial_json ?? "");
          const prev = this.toolJsonBuffer.get(this.openToolId) ?? "";
          const next = `${prev}${partial}`;
          this.toolJsonBuffer.set(this.openToolId, next);
          const tool = this.tools.get(this.openToolId);
          if (tool) {
            try {
              const parsed = JSON.parse(next) as unknown;
              tool.input = summarizeToolInput(tool.name, parsed);
              if (tool.name === "Agent" || tool.name === "Task") this.ensureSubagent(tool.id, parsed);
              else this.updateSubagentActivity(tool.agentId, `${tool.name}${tool.input ? ` · ${tool.input}` : ""}`);
            } catch {
              tool.input = truncate(next, 160);
            }
            return this.emit({
              kind: "tool_input",
              phase: "tool",
              summary: `도구 입력: ${tool.name}`,
              detail: tool.input,
              toolName: tool.name,
              toolId: tool.id,
              sessionId,
              at,
            });
          }
        }
      }
      return null;
    }

    if (type === "assistant") {
      const message = (obj.message ?? {}) as Record<string, unknown>;
      if (typeof message.model === "string") this.observeModel(agentId, message.model);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const raw of content) {
        if (!raw || typeof raw !== "object") continue;
        const block = raw as Record<string, unknown>;
        if (block.type === "tool_use") {
          const id = String(block.id ?? `tool-${this.tools.size + 1}`);
          const name = String(block.name ?? "tool");
          if (name === "Agent" || name === "Task") {
            const track = this.ensureSubagent(id, block.input);
            this.tools.delete(id);
            this.pushTimeline("tool_start", `🔄 ${track.label}`, at);
            return this.emit({
              kind: "tool_start",
              phase: "tool",
              summary: `서브에이전트 실행: ${track.label}`,
              detail: track.label,
              toolName: name,
              toolId: id,
              sessionId,
              at,
            });
          }

          const input = summarizeToolInput(name, block.input);
          this.tools.set(id, { id, name, input, agentId });
          this.openToolId = id;
          this.updateSubagentActivity(agentId, `${name}${input ? ` · ${input}` : ""}`);
          this.pushTimeline("tool_start", `🔧 ${name}${input ? ` · ${input}` : ""}`, at);
          return this.emit({
            kind: "tool_start",
            phase: "tool",
            summary: `도구 실행: ${name}`,
            detail: input,
            toolName: name,
            toolId: id,
            sessionId,
            at,
          });
        }
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          if (agentId === "main") this.liveText = block.text.slice(-4000);
          else this.updateSubagentActivity(agentId, `💬 ${block.text}`);
          this.pushTimeline("text", truncate(block.text, 120), at);
          return this.emit({
            kind: "text",
            phase: "writing",
            summary: "응답 작성 중",
            detail: truncate(block.text, 160),
            sessionId,
            at,
          });
        }
      }
      return null;
    }

    if (type === "user") {
      const message = (obj.message ?? {}) as Record<string, unknown>;
      const content = Array.isArray(message.content) ? message.content : Array.isArray(obj.message) ? (obj.message as unknown[]) : [];
      for (const raw of content) {
        if (!raw || typeof raw !== "object") continue;
        const block = raw as Record<string, unknown>;
        if (block.type === "tool_result") {
          const id = String(block.tool_use_id ?? this.openToolId ?? `tool-${this.tools.size}`);
          const isError = block.is_error === true;
          const subagent = this.subagents.get(id);
          if (subagent) {
            subagent.done = true;
            subagent.lastActivity = "";
            this.tools.delete(id);
            this.pushTimeline("tool_result", `${isError ? "⛔" : "✅"} ${subagent.label}`, at);
            return this.emit({
              kind: "tool_result",
              phase: "tool_result",
              summary: `서브에이전트 완료: ${subagent.label}`,
              toolName: "Agent",
              toolId: id,
              isError,
              sessionId,
              at,
            });
          }
          const rawContent = block.content;
          const text =
            typeof rawContent === "string"
              ? rawContent
              : Array.isArray(rawContent)
                ? rawContent
                    .map((item) => {
                      if (!item || typeof item !== "object") return String(item);
                      const row = item as Record<string, unknown>;
                      return typeof row.text === "string" ? row.text : JSON.stringify(row);
                    })
                    .join("\n")
                : JSON.stringify(rawContent ?? "");
          const tool = this.tools.get(id) ?? {
            id,
            name: "tool",
            input: "",
            agentId,
          };
          tool.result = truncate(text, 240);
          tool.error = isError;
          this.tools.set(id, tool);
          this.updateSubagentActivity(tool.agentId, `${isError ? "⛔" : "✅"} ${tool.name}`);
          this.pushTimeline(
            "tool_result",
            `${isError ? "⛔" : "✅"} ${tool.name} 결과 · ${truncate(text, 100)}`,
            at,
          );
          return this.emit({
            kind: "tool_result",
            phase: "tool_result",
            summary: `${tool.name} 결과 수신`,
            detail: truncate(text, 180),
            toolName: tool.name,
            toolId: id,
            isError,
            sessionId,
            at,
          });
        }
      }
      return null;
    }

    if (type === "result") {
      const result = typeof obj.result === "string" ? obj.result : "";
      const isError = obj.is_error === true || obj.subtype === "error";
      this.finalResult = result;
      this.isError = isError;
      this.numTurns = typeof obj.num_turns === "number" ? obj.num_turns : this.numTurns;
      this.costUsd = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : this.costUsd;
      this.phase = isError ? "failed" : "completed";
      this.statusLabel = isError ? "failed" : "completed";
      this.currentActivity = isError ? "실패로 종료" : "완료";
      if (result) this.liveText = result.slice(-4000);
      this.pushTimeline("result", isError ? "실패 결과 수신" : "최종 결과 수신", at);
      return this.emit({
        kind: "result",
        phase: this.phase,
        summary: this.currentActivity,
        finalResult: result,
        isError,
        sessionId: this.sessionId || sessionId,
        at,
      });
    }

    return null;
  }

  snapshot(): ProgressSnapshot {
    return {
      phase: this.phase,
      statusLabel: this.statusLabel,
      currentActivity: this.currentActivity,
      liveText: this.liveText,
      timeline: [...this.timeline],
      tools: [...this.tools.values()],
      mainModel: this.mainModel,
      modelTransition: this.modelTransition,
      subagents: [...this.subagents.values()].map((track) => ({ ...track })),
      sessionId: this.sessionId,
      numTurns: this.numTurns,
      costUsd: this.costUsd,
      finalResult: this.finalResult,
      isError: this.isError,
      eventCount: this.eventCount,
      dirty: this.dirty,
    };
  }
}

export interface ProgressRenderInput {
  routeId: string;
  attempt: number;
  maxAttempts: number;
  elapsedSeconds: number;
  promptPreview: string;
  recoveryReason?: string | null;
  snapshot: ProgressSnapshot;
  mode?: "running" | "final" | "cancelled";
  ok?: boolean;
}

export function renderProgressCard(input: ProgressRenderInput): string {
  const mode = input.mode ?? "running";
  const snap = input.snapshot;
  const elapsed = formatElapsedKorean(input.elapsedSeconds, {
    bucketSeconds: 5,
    includeSecondsWithHours: true,
  });
  const mainModel = snap.mainModel ? shortModelLabel(snap.mainModel) : "";
  const modelSuffix = mainModel ? ` · ${snap.modelTransition ? "⚡" : ""}${mainModel}` : "";
  const header =
    mode === "cancelled"
      ? `🛑 **작업 취소됨** — ${elapsed}${modelSuffix}`
      : mode === "final"
        ? input.ok
          ? `✅ **작업 완료** — ${elapsed}${modelSuffix}`
          : `⛔ **작업 실패** — ${elapsed}${modelSuffix}`
        : `⏳ **작업 중** — ${elapsed}${modelSuffix}`;

  const trackLabel = (track: SubagentProgress): string => {
    const model = track.model ? shortModelLabel(track.model) : "";
    return model && model !== mainModel ? `${track.label} (${model})` : track.label;
  };

  if (snap.subagents.length > 1) {
    const lines = [header];
    for (const track of snap.subagents) {
      const icon = track.done ? "✅" : "🔄";
      const activity = track.lastActivity && !track.done ? ` · ${track.lastActivity}` : "";
      lines.push(`${icon} ${trackLabel(track)}${activity}`);
    }
    return lines.join("\n");
  }

  type Activity = { text: string; inFlight: boolean };
  const activities: Activity[] = snap.tools
    .filter((tool) => tool.agentId === "main")
    .map((tool) => {
      const mark = tool.error ? "⛔" : tool.result != null ? "✅" : "🔧";
      const inputText = tool.input ? ` · \`${truncate(tool.input, 90)}\`` : "";
      return { text: `${mark} **${tool.name}**${inputText}`, inFlight: !tool.error && tool.result == null };
    });

  if (snap.subagents.length === 1) {
    const track = snap.subagents[0]!;
    activities.push({
      text: `${track.done ? "✅" : "🔄"} **Task** · ${trackLabel(track)}`,
      inFlight: !track.done,
    });
  }

  const live = (snap.liveText || snap.finalResult).trim();
  if (live) activities.push({ text: `💬 ${truncate(live, 180)}`, inFlight: false });

  const recent = activities.slice(-4);
  let activeIndex = -1;
  if (mode === "running") {
    for (let index = 0; index < recent.length; index += 1) {
      if (recent[index]?.inFlight) activeIndex = index;
    }
  }
  const lines = [header];
  for (const [index, activity] of recent.entries()) {
    const branch = index === recent.length - 1 ? "└" : "├";
    const current = index === activeIndex ? " ←" : "";
    lines.push(`${branch} ${activity.text}${current}`);
  }
  return lines.join("\n");
}

export function parseStreamJsonResult(stdout: string, stderr: string, exitCode: number): {
  ok: boolean;
  result: string;
  sessionId: string;
  stderr: string;
  exitCode: number;
  mainModel: string;
  subagentModels: string[];
} {
  const aggregator = new StreamProgressAggregator();
  for (const line of stdout.split("\n")) aggregator.ingestLine(line);
  const snap = aggregator.snapshot();
  const subagentModels = [...new Set(snap.subagents.map((track) => track.model).filter(Boolean))];
  if (snap.finalResult || snap.sessionId) {
    return {
      ok: !snap.isError && exitCode === 0,
      result: (snap.finalResult || snap.liveText || stderr || "(empty Claude result)").slice(0, 16000),
      sessionId: snap.sessionId,
      stderr: stderr.slice(0, 8000),
      exitCode,
      mainModel: snap.mainModel,
      subagentModels,
    };
  }
  // fallback for legacy single-json output
  try {
    const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
    return {
      ok: obj.is_error !== true && exitCode === 0,
      result: String(obj.result ?? stdout).slice(0, 16000),
      sessionId: typeof obj.session_id === "string" ? obj.session_id : "",
      stderr: stderr.slice(0, 8000),
      exitCode,
      mainModel: snap.mainModel,
      subagentModels,
    };
  } catch {
    return {
      ok: exitCode === 0,
      result: (stdout.trim() || stderr.trim() || "(empty Claude result)").slice(0, 16000),
      sessionId: "",
      stderr: stderr.slice(0, 8000),
      exitCode,
      mainModel: snap.mainModel,
      subagentModels,
    };
  }
}
