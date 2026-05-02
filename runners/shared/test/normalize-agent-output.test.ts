import { describe, expect, it } from 'vitest';

import {
  extractMarkdownImageAttachments,
  normalizeAgentOutput,
} from '../src/agent-protocol.js';

describe('normalizeAgentOutput', () => {
  it('extracts markdown image attachments without rewriting normal links', () => {
    expect(
      extractMarkdownImageAttachments(
        '결과입니다.\n![screenshot](/tmp/result.png)\n[code](/tmp/source.ts#L10)',
      ),
    ).toEqual({
      cleanText: '결과입니다.\n\n[code](/tmp/source.ts#L10)',
      attachments: [
        {
          path: '/tmp/result.png',
          name: 'result.png',
        },
      ],
    });
  });

  it('normalizes markdown image output into internal attachments', () => {
    expect(
      normalizeAgentOutput(
        'TASK_DONE\n\n스크린샷입니다.\n![screenshot](/tmp/screenshot.png)',
      ),
    ).toEqual({
      result: 'TASK_DONE\n\n스크린샷입니다.',
      output: {
        visibility: 'public',
        text: 'TASK_DONE\n\n스크린샷입니다.',
        attachments: [
          {
            path: '/tmp/screenshot.png',
            name: 'screenshot.png',
          },
        ],
      },
      attachmentSource: 'markdown-image',
    });
  });

  it('normalizes legacy image tags into internal attachments', () => {
    expect(
      normalizeAgentOutput(
        'TASK_DONE\n\n스크린샷입니다.\n[Image: screenshot.png → /tmp/legacy.png]',
      ),
    ).toEqual({
      result: 'TASK_DONE\n\n스크린샷입니다.',
      output: {
        visibility: 'public',
        text: 'TASK_DONE\n\n스크린샷입니다.',
        attachments: [
          {
            path: '/tmp/legacy.png',
            name: 'legacy.png',
          },
        ],
      },
      attachmentSource: 'image-tag',
    });
  });

  it('normalizes short image tags documented in prompts', () => {
    expect(
      normalizeAgentOutput('TASK_DONE\n\n[Image: /tmp/short-form.png]'),
    ).toEqual({
      result: 'TASK_DONE',
      output: {
        visibility: 'public',
        text: 'TASK_DONE',
        attachments: [
          {
            path: '/tmp/short-form.png',
            name: 'short-form.png',
          },
        ],
      },
      attachmentSource: 'image-tag',
    });
  });

  it('keeps legacy ejclaw JSON as compatibility input', () => {
    expect(
      normalizeAgentOutput(
        JSON.stringify({
          ejclaw: {
            visibility: 'public',
            text: '이미지를 첨부했습니다.',
            verdict: 'done',
            attachments: [
              {
                path: '/tmp/compat.png',
                name: 'compat.png',
                mime: 'image/png',
              },
            ],
          },
        }),
      ),
    ).toEqual({
      result: '이미지를 첨부했습니다.',
      output: {
        visibility: 'public',
        text: '이미지를 첨부했습니다.',
        verdict: 'done',
        attachments: [
          {
            path: '/tmp/compat.png',
            name: 'compat.png',
            mime: 'image/png',
          },
        ],
      },
      attachmentSource: 'legacy-ejclaw-json',
    });
  });
});
