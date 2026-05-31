import { describe, expect, it } from 'vitest';

import {
  attachmentEvidenceCaption,
  expandPromptAttachmentReferences,
  expandImagePromptReferences,
  extractImageTagPaths,
  imageTagCaption,
  missingAttachmentCaption,
  missingImageTagCaption,
  normalizeAgentOutput,
  normalizeEjclawStructuredOutput,
  normalizePublicTextOutput,
  splitPromptAttachmentParts,
  splitImageTagPromptParts,
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

  it('does not extract image tags from code examples', () => {
    const text =
      'inline `[Image: x.png → /x.png]` and fenced\n```text\n[Image: y.png → /y.png]\n```\nreal [Image: z.png → /z.png]';

    expect(extractImageTagPaths(text)).toEqual({
      cleanText:
        'inline `[Image: x.png → /x.png]` and fenced\n```text\n[Image: y.png → /y.png]\n```\nreal',
      imagePaths: ['/z.png'],
    });
  });

  it('splits labeled image tags for multimodal prompt builders', () => {
    expect(
      splitImageTagPromptParts(
        'before [Image: screenshot.png → /tmp/a.png] after',
      ),
    ).toEqual([
      { type: 'text', text: 'before ' },
      {
        type: 'image',
        label: 'screenshot.png',
        path: '/tmp/a.png',
        raw: '[Image: screenshot.png → /tmp/a.png]',
      },
      { type: 'text', text: ' after' },
    ]);
  });

  it('does not split image tags from code examples into prompt images', () => {
    const text =
      '`[Image: inline.png → /tmp/inline.png]` [Image: real.png → /tmp/real.png]';

    expect(splitImageTagPromptParts(text)).toEqual([
      { type: 'text', text: '`[Image: inline.png → /tmp/inline.png]` ' },
      {
        type: 'image',
        label: 'real.png',
        path: '/tmp/real.png',
        raw: '[Image: real.png → /tmp/real.png]',
      },
    ]);
  });

  it('formats image evidence captions and missing-image warnings', () => {
    const part = {
      type: 'image' as const,
      label: 'screenshot.png',
      path: '/tmp/a.png',
      raw: '[Image: screenshot.png → /tmp/a.png]',
    };

    expect(imageTagCaption(part)).toBe('Image evidence: screenshot.png');
    expect(missingImageTagCaption(part, 'file not found')).toBe(
      '[Image unavailable: screenshot.png → /tmp/a.png — file not found]',
    );
  });

  it('expands MEDIA image directives into image prompt tags', () => {
    expect(expandImagePromptReferences('증거\nMEDIA:/tmp/render.png\n끝')).toBe(
      '증거\n[Image: render.png → /tmp/render.png]\n끝',
    );
  });

  it('expands markdown image links into image prompt tags', () => {
    expect(
      expandImagePromptReferences('증거 ![render](/tmp/render.png) 끝'),
    ).toBe('증거 [Image: render.png → /tmp/render.png] 끝');
  });

  it('keeps non-image media and fenced media text unchanged', () => {
    const text =
      'MEDIA:/tmp/demo.mp4\n```text\nMEDIA:/tmp/render.png\n```\n`MEDIA:/tmp/inline.png`';
    expect(expandImagePromptReferences(text)).toBe(text);
  });

  it('expands supported MEDIA documents into file prompt tags', () => {
    expect(
      expandPromptAttachmentReferences('증거\nMEDIA:/tmp/report.pdf'),
    ).toBe('증거\n[File: report.pdf → /tmp/report.pdf]');
  });

  it('splits image and document prompt attachments in order', () => {
    expect(
      splitPromptAttachmentParts(
        'before [Image: render.png → /tmp/render.png] middle [File: report.pdf → /tmp/report.pdf] after',
      ),
    ).toEqual([
      { type: 'text', text: 'before ' },
      {
        type: 'attachment',
        kind: 'image',
        label: 'render.png',
        path: '/tmp/render.png',
        raw: '[Image: render.png → /tmp/render.png]',
        tag: 'Image',
      },
      { type: 'text', text: ' middle ' },
      {
        type: 'attachment',
        kind: 'document',
        label: 'report.pdf',
        path: '/tmp/report.pdf',
        raw: '[File: report.pdf → /tmp/report.pdf]',
        tag: 'File',
      },
      { type: 'text', text: ' after' },
    ]);
  });

  it('does not split prompt attachments from code examples', () => {
    const text =
      '`[File: inline.pdf → /tmp/inline.pdf]` [File: report.pdf → /tmp/report.pdf]';

    expect(splitPromptAttachmentParts(text)).toEqual([
      { type: 'text', text: '`[File: inline.pdf → /tmp/inline.pdf]` ' },
      {
        type: 'attachment',
        kind: 'document',
        label: 'report.pdf',
        path: '/tmp/report.pdf',
        raw: '[File: report.pdf → /tmp/report.pdf]',
        tag: 'File',
      },
    ]);
  });

  it('formats document evidence captions and missing-document warnings', () => {
    const part = {
      type: 'attachment' as const,
      kind: 'document' as const,
      label: 'report.pdf',
      path: '/tmp/report.pdf',
      raw: '[File: report.pdf → /tmp/report.pdf]',
      tag: 'File' as const,
    };

    expect(attachmentEvidenceCaption(part)).toBe(
      'Document evidence: report.pdf',
    );
    expect(missingAttachmentCaption(part, 'file not found')).toBe(
      '[Document unavailable: report.pdf → /tmp/report.pdf — file not found]',
    );
  });

  it('does not extract markdown image attachments from code examples', () => {
    const normalized = normalizeAgentOutput(
      'inline `![x](/x.png)` and fenced\n```md\n![y](/y.png)\n```\nreal ![z](/z.png)',
    );

    expect(normalized.output).toEqual({
      visibility: 'public',
      text: 'inline `![x](/x.png)` and fenced\n```md\n![y](/y.png)\n```\nreal',
      attachments: [{ path: '/z.png', name: 'z.png' }],
    });
    expect(normalized.attachmentSource).toBe('markdown-image');
  });
});

describe('shared agent output normalization', () => {
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
