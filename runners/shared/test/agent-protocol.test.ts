import { describe, expect, it } from 'vitest';

import {
  extractImageTagPaths,
  normalizeEjclawStructuredOutput,
  normalizePublicTextOutput,
  writeProtocolOutput,
} from '../src/agent-protocol.js';

describe('shared agent protocol helpers', () => {
  it('extracts image tags without leaking regex state', () => {
    expect(extractImageTagPaths('hello [Image: /tmp/a.png]')).toEqual({
      cleanText: 'hello',
      imagePaths: ['/tmp/a.png'],
    });
    expect(extractImageTagPaths('[Image: /tmp/b.png] second')).toEqual({
      cleanText: 'second',
      imagePaths: ['/tmp/b.png'],
    });
  });

  it('normalizes plain text runner output as public text', () => {
    expect(normalizePublicTextOutput('DONE')).toEqual({
      result: 'DONE',
      output: {
        visibility: 'public',
        text: 'DONE',
      },
    });
  });

  it('parses silent ejclaw envelopes', () => {
    expect(
      normalizeEjclawStructuredOutput(
        JSON.stringify({
          ejclaw: { visibility: 'silent', verdict: 'silent' },
        }),
      ),
    ).toEqual({
      result: null,
      output: {
        visibility: 'silent',
        verdict: 'silent',
      },
    });
  });

  it('falls back to visible raw text on invalid public verdicts', () => {
    const raw = JSON.stringify({
      ejclaw: {
        visibility: 'public',
        text: 'DONE',
        verdict: 'mystery',
      },
    });

    expect(normalizeEjclawStructuredOutput(raw)).toEqual({
      result: raw,
      output: {
        visibility: 'public',
        text: raw,
      },
    });
  });

  it('writes marker-delimited protocol output', () => {
    const lines: string[] = [];
    writeProtocolOutput({ status: 'success', result: 'ok' }, (line) => {
      lines.push(line);
    });

    expect(lines).toEqual([
      '---EJCLAW_OUTPUT_START---',
      '{"status":"success","result":"ok"}',
      '---EJCLAW_OUTPUT_END---',
    ]);
  });
});
