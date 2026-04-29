import { describe, expect, it } from 'vitest';

import {
  classifyArbiterVerdict,
  parseVisibleVerdict,
} from './paired-verdict.js';

describe('paired verdict parser', () => {
  it('parses visible verdicts from the first summary line only', () => {
    expect(parseVisibleVerdict('STEP_DONE\nmore to do')).toBe('step_done');
    expect(parseVisibleVerdict('TASK_DONE\nall done')).toBe('task_done');
    expect(
      parseVisibleVerdict(
        'DONE_WITH_CONCERNS\n\nfollow-up detail that should not affect parsing',
      ),
    ).toBe('done_with_concerns');
    expect(parseVisibleVerdict('BLOCKED\nextra detail')).toBe('blocked');
    expect(parseVisibleVerdict('random prose')).toBe('continue');
  });

  it('classifies arbiter verdicts from the first visible line', () => {
    expect(classifyArbiterVerdict('PROCEED\ncontinue')).toBe('proceed');
    expect(classifyArbiterVerdict('**VERDICT: REVISE**\nfix it')).toBe(
      'revise',
    );
    expect(
      classifyArbiterVerdict(
        '<internal>private notes</internal>\nVERDICT — RESET\nrestart',
      ),
    ).toBe('reset');
    expect(classifyArbiterVerdict('ESCALATE\nblocked')).toBe('escalate');
    expect(classifyArbiterVerdict('no verdict here')).toBe('unknown');
  });
});
