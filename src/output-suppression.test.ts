import { describe, expect, it } from 'vitest';

import {
  buildStructuredOutputPrompt,
  classifySuppressTokenOutput,
  parseStructuredOutputEnvelope,
} from './output-suppression.js';

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

  it('treats the exact structured silent envelope as exact silent output', () => {
    expect(
      classifySuppressTokenOutput(
        '{"ejclaw":{"visibility":"silent"}}',
        undefined,
      ),
    ).toBe('exact');
  });
});

describe('parseStructuredOutputEnvelope', () => {
  it('parses the exact silent envelope', () => {
    expect(
      parseStructuredOutputEnvelope('{"ejclaw":{"visibility":"silent"}}'),
    ).toEqual({ visibility: 'silent' });
  });

  it('parses a public envelope', () => {
    expect(
      parseStructuredOutputEnvelope(
        '{"ejclaw":{"visibility":"public","text":"hello"}}',
      ),
    ).toEqual({ visibility: 'public', text: 'hello' });
  });
});

describe('buildStructuredOutputPrompt', () => {
  it('prepends the structured output control block', () => {
    expect(buildStructuredOutputPrompt('hello')).toContain(
      'If you have no user-visible content to send for this turn, output exactly this JSON and nothing else: {"ejclaw":{"visibility":"silent"}}',
    );
  });
});
