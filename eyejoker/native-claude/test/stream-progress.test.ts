import { describe, expect, test } from "bun:test";
import {
  StreamProgressAggregator,
  parseStreamJsonResult,
  renderProgressCard,
} from "../src/stream-progress";

const sample = `
{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-fable-5"}
{"type":"system","subtype":"status","status":"requesting","session_id":"sess-1"}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}},"session_id":"sess-1"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}},"session_id":"sess-1"}
{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}},"session_id":"sess-1"}
{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"echo HI\\",\\"description\\":\\"probe\\"}"}},"session_id":"sess-1"}
{"type":"assistant","parent_tool_use_id":null,"message":{"model":"claude-fable-5","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo HI","description":"probe"}}]},"session_id":"sess-1"}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"HI","is_error":false}]},"session_id":"sess-1"}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"sess-1"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"DONE"}},"session_id":"sess-1"}
{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"sess-1","num_turns":2,"total_cost_usd":0.0123}
`.trim();

const subagentSample = `
{"type":"system","subtype":"init","session_id":"sess-agent","model":"claude-fable-5"}
{"type":"assistant","parent_tool_use_id":null,"message":{"model":"claude-fable-5","content":[{"type":"tool_use","id":"agent_1","name":"Agent","input":{"description":"GPT 교차 검증","subagent_type":"gpt-worker","prompt":"검증해"}},{"type":"tool_use","id":"agent_2","name":"Agent","input":{"description":"Fable 구현 검증","subagent_type":"fable-worker","prompt":"구현해"}}]},"session_id":"sess-agent"}
{"type":"assistant","parent_tool_use_id":"agent_1","message":{"model":"gpt-5.6-sol","content":[{"type":"tool_use","id":"child_bash","name":"Bash","input":{"command":"echo CHILD"}}]},"session_id":"sess-agent"}
{"type":"assistant","parent_tool_use_id":"agent_2","message":{"model":"claude-fable-5","content":[{"type":"text","text":"FABLE_CHILD"}]},"session_id":"sess-agent"}
{"type":"user","parent_tool_use_id":"agent_1","message":{"content":[{"type":"tool_result","tool_use_id":"child_bash","content":"CHILD","is_error":false}]},"session_id":"sess-agent"}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent_1","content":"GPT_CHILD_OK","is_error":false},{"type":"tool_result","tool_use_id":"agent_2","content":"FABLE_CHILD_OK","is_error":false}]},"session_id":"sess-agent"}
{"type":"result","subtype":"success","is_error":false,"result":"PARENT_OK","session_id":"sess-agent"}
`.trim();

describe("stream progress aggregator", () => {
  test("tracks tools, live text, timeline and final result from stream-json", () => {
    const agg = new StreamProgressAggregator();
    const kinds: string[] = [];
    for (const line of sample.split("\n")) {
      const event = agg.ingestLine(line);
      if (event) kinds.push(event.kind);
    }
    const snap = agg.snapshot();
    expect(kinds).toContain("tool_start");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("text");
    expect(kinds).toContain("result");
    expect(snap.sessionId).toBe("sess-1");
    expect(snap.mainModel).toBe("claude-fable-5");
    expect(snap.tools[0]?.name).toBe("Bash");
    expect(snap.tools[0]?.input).toContain("echo HI");
    expect(snap.tools[0]?.result).toBe("HI");
    expect(snap.liveText).toContain("DONE");
    expect(snap.finalResult).toBe("DONE");
    expect(snap.phase).toBe("completed");
    expect(snap.numTurns).toBe(2);
  });

  test("renders NanoClaw-style compact activity tree without diagnostic sections", () => {
    const agg = new StreamProgressAggregator();
    for (const line of sample.split("\n")) agg.ingestLine(line);
    const card = renderProgressCard({
      routeId: "cleanapo",
      attempt: 1,
      maxAttempts: 2,
      elapsedSeconds: 75,
      promptPreview: "버그 고치고 테스트까지",
      snapshot: agg.snapshot(),
      mode: "running",
    });
    expect(card).toContain("⏳ **작업 중** — 1분 15초 · fable-5");
    expect(card).toContain("✅ **Bash**");
    expect(card).toContain("💬 DONE");
    expect(card).not.toContain("**요청**");
    expect(card).not.toContain("**현재**");
    expect(card).not.toContain("**도구**");
    expect(card).not.toContain("**타임라인**");
    expect(card).not.toContain("**라이브 출력**");
    expect(card.length).toBeLessThanOrEqual(1900);

    const longCard = renderProgressCard({
      routeId: "cleanapo",
      attempt: 1,
      maxAttempts: 2,
      elapsedSeconds: 4_328,
      promptPreview: "장기 작업",
      snapshot: agg.snapshot(),
      mode: "running",
    });
    expect(longCard).toContain("⏳ **작업 중** — 1시간 12분");
    expect(longCard).not.toContain("72분");
  });

  test("tracks actual subagent models and renders old EJClaw-style model tags", () => {
    const agg = new StreamProgressAggregator();
    for (const line of subagentSample.split("\n")) agg.ingestLine(line);
    const snap = agg.snapshot();
    expect(snap.mainModel).toBe("claude-fable-5");
    expect(snap.subagents).toEqual([
      expect.objectContaining({
        id: "agent_1",
        label: "GPT 교차 검증",
        model: "gpt-5.6-sol",
        done: true,
      }),
      expect.objectContaining({
        id: "agent_2",
        label: "Fable 구현 검증",
        model: "claude-fable-5",
        done: true,
      }),
    ]);

    const card = renderProgressCard({
      routeId: "native-pilot",
      attempt: 1,
      maxAttempts: 2,
      elapsedSeconds: 75,
      promptPreview: "mixed model check",
      snapshot: snap,
      mode: "running",
    });
    expect(card).toContain("⏳ **작업 중** — 1분 15초 · fable-5");
    expect(card).toContain("GPT 교차 검증 (gpt-5.6-sol)");
    expect(card).toContain("Fable 구현 검증");
    expect(card).not.toContain("Fable 구현 검증 (fable-5)");
  });

  test("resets prior activity at a Discord interaction boundary and suppresses its late tool result", () => {
    const agg = new StreamProgressAggregator();
    agg.ingestObject({ type: "system", subtype: "init", session_id: "interaction-session", model: "claude-fable-5" });
    agg.ingestObject({
      type: "assistant",
      message: {
        model: "claude-fable-5",
        content: [
          { type: "tool_use", id: "old-1", name: "Read", input: { file_path: "/tmp/old" } },
          { type: "tool_use", id: "old-2", name: "Bash", input: { command: "echo OLD" } },
          {
            type: "tool_use",
            id: "ask-1",
            name: "AskUserQuestion",
            input: { questions: [{ question: "계속?", options: [{ label: "예" }, { label: "아니오" }] }] },
          },
        ],
      },
      session_id: "interaction-session",
    });
    agg.ingestObject({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "old-1", content: "OLD_READ", is_error: false },
          { type: "tool_result", tool_use_id: "old-2", content: "OLD_BASH", is_error: false },
        ],
      },
      session_id: "interaction-session",
    });

    const reset = (agg as unknown as { resetAfterInteraction?: (toolUseId?: string) => void }).resetAfterInteraction;
    expect(reset).toBeFunction();
    reset!.call(agg, "ask-1");
    expect(agg.snapshot()).toMatchObject({
      tools: [],
      timeline: [],
      liveText: "",
      subagents: [],
      mainModel: "claude-fable-5",
      sessionId: "interaction-session",
    });

    agg.ingestObject({
      type: "assistant",
      message: {
        model: "claude-fable-5",
        content: [{ type: "tool_use", id: "ask-1", name: "AskUserQuestion", input: {} }],
      },
      session_id: "interaction-session",
    });
    agg.ingestObject({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "ask-1", content: "예", is_error: false }] },
      session_id: "interaction-session",
    });
    expect(agg.snapshot().tools).toEqual([]);

    agg.ingestObject({
      type: "assistant",
      message: {
        model: "claude-fable-5",
        content: [{ type: "tool_use", id: "new-bash", name: "Bash", input: { command: "echo NEW" } }],
      },
      session_id: "interaction-session",
    });
    const card = renderProgressCard({
      routeId: "native-pilot",
      attempt: 1,
      maxAttempts: 2,
      elapsedSeconds: 90,
      promptPreview: "interaction reset",
      snapshot: agg.snapshot(),
      mode: "running",
    });
    expect(card).toContain("echo NEW");
    expect(card).not.toContain("echo OLD");
    expect(card).not.toContain("AskUserQuestion");
    expect(card).not.toContain("OLD_READ");
  });

  test("preserves long terminal results so trailing artifact markers survive", () => {
    const result = `${"x".repeat(20_000)}\nMEDIA:/tmp/result.png`;
    const parsed = parseStreamJsonResult(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "long" }),
      "",
      0,
    );
    expect(parsed.result).toBe(result);
    expect(parsed.result.endsWith("MEDIA:/tmp/result.png")).toBe(true);
  });

  test("fails closed when the process exits zero without a terminal result event", () => {
    const parsed = parseStreamJsonResult(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "session-no-result" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "아직 작업 중" }] } }),
      ].join("\n"),
      "",
      0,
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.result).toContain("protocol error");
  });

  test("parseStreamJsonResult extracts the terminal result event", () => {
    const parsed = parseStreamJsonResult(sample, "", 0);
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toBe("DONE");
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.mainModel).toBe("claude-fable-5");
    expect(parsed.subagentModels).toEqual([]);
  });
});
