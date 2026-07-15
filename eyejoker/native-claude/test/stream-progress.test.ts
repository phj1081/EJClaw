import { describe, expect, test } from "bun:test";
import {
  StreamProgressAggregator,
  parseStreamJsonResult,
  renderProgressCard,
} from "../src/stream-progress";

const sample = `
{"type":"system","subtype":"init","session_id":"sess-1"}
{"type":"system","subtype":"status","status":"requesting","session_id":"sess-1"}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}},"session_id":"sess-1"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}},"session_id":"sess-1"}
{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}},"session_id":"sess-1"}
{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"echo HI\\",\\"description\\":\\"probe\\"}"}},"session_id":"sess-1"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"echo HI","description":"probe"}}]},"session_id":"sess-1"}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"HI","is_error":false}]},"session_id":"sess-1"}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"sess-1"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"DONE"}},"session_id":"sess-1"}
{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"sess-1","num_turns":2,"total_cost_usd":0.0123}
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
    expect(snap.tools[0]?.name).toBe("Bash");
    expect(snap.tools[0]?.input).toContain("echo HI");
    expect(snap.tools[0]?.result).toBe("HI");
    expect(snap.liveText).toContain("DONE");
    expect(snap.finalResult).toBe("DONE");
    expect(snap.phase).toBe("completed");
    expect(snap.numTurns).toBe(2);
  });

  test("renders a full progress card under Discord length limits", () => {
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
    expect(card).toContain("작업 진행 중");
    expect(card).toContain("cleanapo");
    expect(card).toContain("Bash");
    expect(card).toContain("타임라인");
    expect(card).toContain("DONE");
    expect(card.length).toBeLessThanOrEqual(1900);
  });

  test("parseStreamJsonResult extracts the terminal result event", () => {
    const parsed = parseStreamJsonResult(sample, "", 0);
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toBe("DONE");
    expect(parsed.sessionId).toBe("sess-1");
  });
});
