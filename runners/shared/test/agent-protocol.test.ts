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
    expect(
      extractImageTagPaths('hello [Image: screenshot.png → /tmp/a.png]'),
    ).toEqual({
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

  it('parses public ejclaw attachments', () => {
    expect(
      normalizeEjclawStructuredOutput(
        JSON.stringify({
          ejclaw: {
            visibility: 'public',
            text: '이미지를 생성했습니다.',
            verdict: 'done',
            attachments: [
              {
                path: '/tmp/image.png',
                name: 'image.png',
                mime: 'image/png',
              },
            ],
          },
        }),
      ),
    ).toEqual({
      result: '이미지를 생성했습니다.',
      output: {
        visibility: 'public',
        text: '이미지를 생성했습니다.',
        verdict: 'done',
        attachments: [
          {
            path: '/tmp/image.png',
            name: 'image.png',
            mime: 'image/png',
          },
        ],
      },
    });
  });

  it('parses fenced public ejclaw attachments', () => {
    expect(
      normalizeEjclawStructuredOutput(`\`\`\`json
{
  "ejclaw": {
    "visibility": "public",
    "text": "검 아이콘을 생성했습니다.",
    "verdict": "done",
    "attachments": [
      {
        "path": "/tmp/imagegen-sword.png",
        "name": "imagegen-sword.png",
        "mime": "image/png"
      }
    ]
  }
}
\`\`\``),
    ).toEqual({
      result: '검 아이콘을 생성했습니다.',
      output: {
        visibility: 'public',
        text: '검 아이콘을 생성했습니다.',
        verdict: 'done',
        attachments: [
          {
            path: '/tmp/imagegen-sword.png',
            name: 'imagegen-sword.png',
            mime: 'image/png',
          },
        ],
      },
    });
  });

  it('parses fenced ejclaw envelopes with leading invisible control characters', () => {
    expect(
      normalizeEjclawStructuredOutput(`\u2063\u2063\u2063\`\`\`json
{
  "ejclaw": {
    "visibility": "public",
    "text": "최종 이미지를 첨부했습니다.",
    "verdict": "done",
    "attachments": [
      {
        "path": "/tmp/ejclaw-discord-image-final.png",
        "name": "final.png",
        "mime": "image/png"
      }
    ]
  }
}
\`\`\``),
    ).toEqual({
      result: '최종 이미지를 첨부했습니다.',
      output: {
        visibility: 'public',
        text: '최종 이미지를 첨부했습니다.',
        verdict: 'done',
        attachments: [
          {
            path: '/tmp/ejclaw-discord-image-final.png',
            name: 'final.png',
            mime: 'image/png',
          },
        ],
      },
    });
  });

  it('parses status-prefixed fenced public ejclaw attachments', () => {
    expect(
      normalizeEjclawStructuredOutput(`TASK_DONE

\`\`\`json
{
  "ejclaw": {
    "visibility": "public",
    "text": "이미지를 첨부했습니다.",
    "verdict": "done",
    "attachments": [
      {
        "path": "/tmp/ejclaw-discord-image-status.png",
        "name": "status.png",
        "mime": "image/png"
      }
    ]
  }
}
\`\`\``),
    ).toEqual({
      result: 'TASK_DONE\n\n이미지를 첨부했습니다.',
      output: {
        visibility: 'public',
        text: 'TASK_DONE\n\n이미지를 첨부했습니다.',
        verdict: 'done',
        attachments: [
          {
            path: '/tmp/ejclaw-discord-image-status.png',
            name: 'status.png',
            mime: 'image/png',
          },
        ],
      },
    });
  });
});

describe('shared agent protocol fallback behavior', () => {
  it('parses in_progress public envelopes instead of leaking raw structured JSON', () => {
    const raw = JSON.stringify({
      ejclaw: {
        visibility: 'public',
        text: '이미지를 생성하는 중입니다.',
        verdict: 'in_progress',
        attachments: [
          {
            path: '/tmp/ejclaw-discord-image-draft.png',
            name: 'draft.png',
            mime: 'image/png',
          },
        ],
      },
    });

    const normalized = normalizeEjclawStructuredOutput(raw);

    expect(normalized).toEqual({
      result: '이미지를 생성하는 중입니다.',
      output: {
        visibility: 'public',
        text: '이미지를 생성하는 중입니다.',
        verdict: 'in_progress',
        attachments: [
          {
            path: '/tmp/ejclaw-discord-image-draft.png',
            name: 'draft.png',
            mime: 'image/png',
          },
        ],
      },
    });
    expect(normalized.result).not.toContain('"ejclaw"');
  });

  it('parses unlabeled fenced ejclaw envelopes', () => {
    expect(
      normalizeEjclawStructuredOutput(`\`\`\`
{"ejclaw":{"visibility":"public","text":"스크린샷입니다.","verdict":"done"}}
\`\`\``),
    ).toEqual({
      result: '스크린샷입니다.',
      output: {
        visibility: 'public',
        text: '스크린샷입니다.',
        verdict: 'done',
      },
    });
  });

  it('does not parse mixed prose and fenced ejclaw JSON as structured output', () => {
    const raw = `설명입니다.

\`\`\`json
{"ejclaw":{"visibility":"public","text":"첨부입니다.","verdict":"done"}}
\`\`\``;

    expect(normalizeEjclawStructuredOutput(raw)).toEqual({
      result: raw,
      output: {
        visibility: 'public',
        text: raw,
      },
    });
  });

  it('falls back when fenced JSON has no ejclaw envelope', () => {
    const raw = `\`\`\`json
{"text":"plain json"}
\`\`\``;

    expect(normalizeEjclawStructuredOutput(raw)).toEqual({
      result: raw,
      output: {
        visibility: 'public',
        text: raw,
      },
    });
  });

  it('falls back when multiple fenced JSON blocks are present', () => {
    const raw = `\`\`\`json
{"ejclaw":{"visibility":"public","text":"첫 번째","verdict":"done"}}
\`\`\`

\`\`\`json
{"ejclaw":{"visibility":"public","text":"두 번째","verdict":"done"}}
\`\`\``;

    expect(normalizeEjclawStructuredOutput(raw)).toEqual({
      result: raw,
      output: {
        visibility: 'public',
        text: raw,
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
