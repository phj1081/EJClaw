import { describe, expect, it } from 'vitest';

import {
  classifyArbiterVerdict,
  parseVisibleVerdict,
} from './paired-verdict.js';

describe('paired verdict parser', () => {
  it('parses visible verdicts from leading summary lines', () => {
    expect(parseVisibleVerdict('STEP_DONE\nmore to do')).toBe('step_done');
    expect(parseVisibleVerdict('TASK_DONE\nall done')).toBe('task_done');
    expect(
      parseVisibleVerdict(
        'DONE_WITH_CONCERNS\n\nfollow-up detail that should not affect parsing',
      ),
    ).toBe('done_with_concerns');
    expect(parseVisibleVerdict('BLOCKED\nextra detail')).toBe('blocked');
    expect(parseVisibleVerdict('ESCALATE\nuser decision needed')).toBe(
      'escalate',
    );
    expect(parseVisibleVerdict('random prose')).toBe('continue');
  });

  it('accepts status tokens a few visible lines into the summary', () => {
    expect(
      parseVisibleVerdict(
        [
          '판단부터 적겠습니다.',
          '검증 결과는 아래와 같습니다.',
          'STEP_DONE',
          '',
          '나머지 설명입니다.',
        ].join('\n'),
      ),
    ).toBe('step_done');
  });

  it('ignores status tokens in prose or code fences', () => {
    expect(
      parseVisibleVerdict('검토 결과 STEP_DONE으로 보입니다.\n세부 내용'),
    ).toBe('continue');
    expect(
      parseVisibleVerdict(
        ['```text', 'TASK_DONE', '```', '본문에는 상태가 없습니다.'].join('\n'),
      ),
    ).toBe('continue');
  });

  it('accepts status tokens after a longer evidence preface', () => {
    expect(
      parseVisibleVerdict(
        [
          '첫 줄',
          '둘째 줄',
          '셋째 줄',
          '넷째 줄',
          '다섯째 줄',
          'TASK_DONE',
        ].join('\n'),
      ),
    ).toBe('task_done');
  });

  it('does not scan beyond the leading visible line window', () => {
    expect(
      parseVisibleVerdict(
        [
          '01',
          '02',
          '03',
          '04',
          '05',
          '06',
          '07',
          '08',
          '09',
          '10',
          '11',
          '12',
          'TASK_DONE',
        ].join('\n'),
      ),
    ).toBe('continue');
  });

  it('classifies arbiter verdicts from leading visible lines', () => {
    expect(classifyArbiterVerdict('PROCEED\ncontinue')).toBe('proceed');
    expect(classifyArbiterVerdict('**VERDICT: REVISE**\nfix it')).toBe(
      'revise',
    );
    expect(
      classifyArbiterVerdict(
        ['중재 판단을 정리합니다.', 'VERDICT: REVISE', 'fix it'].join('\n'),
      ),
    ).toBe('revise');
    expect(
      classifyArbiterVerdict(
        '<internal>private notes</internal>\nVERDICT — RESET\nrestart',
      ),
    ).toBe('reset');
    expect(classifyArbiterVerdict('ESCALATE\nblocked')).toBe('escalate');
    expect(classifyArbiterVerdict('CONTINUE\nsame as proceed')).toBe('proceed');
    expect(classifyArbiterVerdict('no verdict here')).toBe('unknown');
  });
});
