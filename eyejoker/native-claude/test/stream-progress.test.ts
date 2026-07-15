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
{"type":"assistant","parent_tool_use_id":null,"message":{"model":"claude-fable-5","content":[{"type":"tool_use","id":"agent_1","name":"Agent","input":{"description":"교차 검증","subagent_type":"gpt-worker","prompt":"검증해"}}]},"session_id":"sess-agent"}
{"type":"assistant","parent_tool_use_id":"agent_1","message":{"model":"gpt-5.6-sol","content":[{"type":"tool_use","id":"child_bash","name":"Bash","input":{"command":"echo CHILD"}}]},"session_id":"sess-agent"}
{"type":"user","parent_tool_use_id":"agent_1","message":{"content":[{"type":"tool_result","tool_use_id":"child_bash","content":"CHILD","is_error":false}]},"session_id":"sess-agent"}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent_1","content":"CHILD_OK","is_error":false}]},"session_id":"sess-agent"}
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
        label: "교차 검증",
        model: "gpt-5.6-sol",
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
    expect(card).toContain("교차 검증 (gpt-5.6-sol)");
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
