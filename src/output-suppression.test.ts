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

  it('treats a truncated structured silent envelope as mixed', () => {
    expect(
      classifySuppressTokenOutput(
        '{"ejclaw":{"visibility":"silent"',
        undefined,
      ),
    ).toBe('mixed');
  });

  it('treats a structured silent envelope mixed with extra text as mixed', () => {
    expect(
      classifySuppressTokenOutput(
        '{"ejclaw":{"visibility":"silent"}} extra',
        undefined,
      ),
    ).toBe('mixed');
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

  it('parses a public envelope with a reviewer verdict', () => {
    expect(
      parseStructuredOutputEnvelope(
        '{"ejclaw":{"visibility":"public","verdict":"done_with_concerns","text":"**DONE_WITH_CONCERNS**"}}',
      ),
    ).toEqual({
      visibility: 'public',
      verdict: 'done_with_concerns',
      text: '**DONE_WITH_CONCERNS**',
    });
  });
});

describe('buildStructuredOutputPrompt', () => {
  it('prepends the structured output control block', () => {
    expect(buildStructuredOutputPrompt('hello')).toContain(
      'If you have no user-visible content to send for this turn, output exactly this JSON and nothing else: {"ejclaw":{"visibility":"silent"}}',
    );
    expect(buildStructuredOutputPrompt('hello')).toContain(
      'If you have already emitted any visible progress, status update, or partial answer earlier in this turn, do not end with the JSON object. Finish with a short visible final conclusion for the user instead.',
    );
  });

  it('tightens the reviewer silent rule when reviewer mode is enabled', () => {
    expect(
      buildStructuredOutputPrompt('hello', { reviewerMode: true }),
    ).toContain(
      'If you have not already emitted any visible progress, status update, or partial answer in this turn and you are only agreeing, mirroring, or restating without adding a concrete correction, risk, missing prerequisite, test gap, or code change, output only the JSON object.',
    );
  });

  it('requires a visible structured verdict on reviewer gate turns', () => {
    expect(
      buildStructuredOutputPrompt('hello', {
        reviewerMode: true,
        gateTurnKind: 'implementation_start',
        requiresVisibleVerdict: true,
      }),
    ).toContain(
      'This turn is a paired-room gate turn for implementation_start. Silent output is forbidden.',
    );
    expect(
      buildStructuredOutputPrompt('hello', {
        reviewerMode: true,
        gateTurnKind: 'implementation_start',
        requiresVisibleVerdict: true,
      }),
    ).toContain(
      'Allowed verdict values are: "done", "done_with_concerns", "blocked".',
    );
  });
});
