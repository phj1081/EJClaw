import { describe, expect, it } from 'vitest';

import { classifySuppressTokenOutput } from './output-suppression.js';

describe('classifySuppressTokenOutput', () => {
  it('treats the current turn suppress token as exact', () => {
    expect(
      classifySuppressTokenOutput(
        '__EJ_SUPPRESS_deadbeefdeadbeefdeadbeef__',
        '__EJ_SUPPRESS_deadbeefdeadbeefdeadbeef__',
      ),
    ).toBe('exact');
  });

  it('treats a leaked foreign suppress token as exact silent output', () => {
    expect(
      classifySuppressTokenOutput(
        '__EJ_SUPPRESS_feedfacefeedfacefeedface__',
        '__EJ_SUPPRESS_deadbeefdeadbeefdeadbeef__',
      ),
    ).toBe('exact');
  });

  it('treats a malformed foreign suppress token without the closing suffix as exact silent output', () => {
    expect(
      classifySuppressTokenOutput(
        '__EJ_SUPPRESS_feedfacefeedfacefeedface',
        '__EJ_SUPPRESS_deadbeefdeadbeefdeadbeef__',
      ),
    ).toBe('exact');
  });

  it('treats a suppress token embedded in visible text as mixed', () => {
    expect(
      classifySuppressTokenOutput(
        'prefix __EJ_SUPPRESS_feedfacefeedfacefeedface__ suffix',
        '__EJ_SUPPRESS_deadbeefdeadbeefdeadbeef__',
      ),
    ).toBe('mixed');
  });
});
