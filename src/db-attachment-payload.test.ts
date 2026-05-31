import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import { logger } from './logger.js';
import { parseAttachmentPayload } from './db/work-items.js';

describe('attachment payload parsing', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockReset();
  });

  it('logs malformed JSON without throwing or breaking old rows', () => {
    const attachments = parseAttachmentPayload('{"path":', {
      table: 'work_items',
      rowId: 42,
    });

    expect(attachments).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        table: 'work_items',
        rowId: 42,
        reason: 'invalid_json',
        payloadLength: 8,
        payloadPreview: '{"path":',
        err: expect.any(SyntaxError),
      }),
      'Ignored malformed attachment payload',
    );
  });

  it('logs non-array attachment JSON without throwing', () => {
    const payload = '{"path":"/tmp/image.png"}';
    const attachments = parseAttachmentPayload(payload, {
      table: 'paired_turn_outputs',
      rowId: 7,
    });

    expect(attachments).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        table: 'paired_turn_outputs',
        rowId: 7,
        reason: 'not_array',
        payloadLength: payload.length,
        payloadPreview: payload,
      }),
      'Ignored malformed attachment payload',
    );
  });

  it('keeps valid attachments while logging malformed entries', () => {
    const payload = JSON.stringify([
      { path: '/tmp/image.png', name: 'image.png', mime: 'image/png' },
      { name: 'missing-path.png' },
      null,
    ]);

    const attachments = parseAttachmentPayload(payload, {
      table: 'work_items',
      rowId: 43,
    });

    expect(attachments).toEqual([
      { path: '/tmp/image.png', name: 'image.png', mime: 'image/png' },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        table: 'work_items',
        rowId: 43,
        invalidEntryCount: 2,
        validEntryCount: 1,
        payloadLength: payload.length,
        payloadPreview: payload,
      }),
      'Ignored invalid attachment payload entries',
    );
  });
});
