import { describe, expect, it } from 'vitest';

import {
  extractMarkdownImageAttachments,
  extractMediaAttachments,
  normalizeAgentOutput,
} from '../src/agent-protocol.js';

describe('normalizeAgentOutput', () => {
  it('extracts markdown image attachments without rewriting normal links', () => {
    expect(
      extractMarkdownImageAttachments(
        '결과입니다.\n![screenshot](/tmp/result.png)\n[render link](/tmp/render.png)\n[code](/tmp/source.ts#L10)',
      ),
    ).toEqual({
      cleanText:
        '결과입니다.\n\n[render link](/tmp/render.png)\n[code](/tmp/source.ts#L10)',
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

  it('normalizes MEDIA directives into internal attachments', () => {
    expect(
      normalizeAgentOutput(
        'TASK_DONE\n\n사운드 프리뷰입니다.\nMEDIA:/tmp/adventurer-active-sfx-preview.mp4',
      ),
    ).toEqual({
      result: 'TASK_DONE\n\n사운드 프리뷰입니다.',
      output: {
        visibility: 'public',
        text: 'TASK_DONE\n\n사운드 프리뷰입니다.',
        attachments: [
          {
            path: '/tmp/adventurer-active-sfx-preview.mp4',
            name: 'adventurer-active-sfx-preview.mp4',
            mime: 'video/mp4',
          },
        ],
      },
      attachmentSource: 'media-tag',
    });
  });

  it('extracts quoted MEDIA paths with spaces', () => {
    expect(
      extractMediaAttachments(
        '프리뷰\nMEDIA:"/tmp/Maldhalla Demo/preview.mp4"',
      ),
    ).toEqual({
      cleanText: '프리뷰',
      attachments: [
        {
          path: '/tmp/Maldhalla Demo/preview.mp4',
          name: 'preview.mp4',
          mime: 'video/mp4',
        },
      ],
    });
  });

  it('does not treat MEDIA references in code fences as attachments', () => {
    const content = '```text\nMEDIA:/tmp/not-an-attachment.mp4\n```';
    expect(extractMediaAttachments(content)).toEqual({
      cleanText: content,
      attachments: [],
    });
  });

  it('does not treat inbound attachment placeholders as outbound directives', () => {
    expect(
      normalizeAgentOutput(
        'TASK_DONE\n\n[Video: preview.mp4 → /tmp/preview.mp4]\n확인했습니다.',
      ),
    ).toEqual({
      result:
        'TASK_DONE\n\n[Video: preview.mp4 → /tmp/preview.mp4]\n확인했습니다.',
      output: {
        visibility: 'public',
        text: 'TASK_DONE\n\n[Video: preview.mp4 → /tmp/preview.mp4]\n확인했습니다.',
      },
      attachmentSource: 'none',
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
