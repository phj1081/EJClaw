import { describe, expect, it, vi } from 'vitest';

import { compactBoundaryFromMessage } from '../src/compaction-boundary.js';

describe('compactBoundaryFromMessage', () => {
  it('extracts compact boundary metadata from SDK system messages', () => {
    const log = vi.fn();

    const compaction = compactBoundaryFromMessage(
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 1234,
        },
      },
      log,
    );

    expect(compaction).toEqual({
      completed: true,
      trigger: 'manual',
    });
    expect(log).toHaveBeenCalledWith(
      'Compact boundary — trigger=manual pre_tokens=1234',
    );
  });

  it('ignores unrelated SDK messages', () => {
    expect(
      compactBoundaryFromMessage({ type: 'assistant' }, vi.fn()),
    ).toBeUndefined();
  });
});
