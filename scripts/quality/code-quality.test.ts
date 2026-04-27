import { describe, expect, it } from 'vitest';

import { analyzeCodeQuality, evaluateCodeQuality } from './code-quality.js';

describe('code quality evaluator', () => {
  it('measures line count and function metrics from TypeScript source', () => {
    const metrics = analyzeCodeQuality(
      'sample.ts',
      [
        'export function choose(value: number) {',
        '  if (value > 10) {',
        '    return value;',
        '  }',
        '  return value > 0 ? value : 0;',
        '}',
      ].join('\n'),
    );

    expect(metrics.lineCount).toBe(6);
    expect(metrics.nonEmptyLineCount).toBe(6);
    expect(metrics.maxFunctionLines).toBe(6);
    expect(metrics.maxComplexity).toBeGreaterThanOrEqual(3);
    expect(metrics.maxNesting).toBeGreaterThanOrEqual(1);
  });

  it('does not let nested functions inflate the parent function budget', () => {
    const metrics = analyzeCodeQuality(
      'nested.ts',
      [
        'export function outer() {',
        '  const inner = () => {',
        '    if (true) return 1;',
        '    return 0;',
        '  };',
        '  return inner();',
        '}',
      ].join('\n'),
    );

    expect(metrics.maxComplexity).toBe(2);
  });

  it('returns budget findings for metrics over the configured limit', () => {
    const metrics = analyzeCodeQuality(
      'oversized.ts',
      ['export function f() {', '  return 1;', '}'].join('\n'),
    );

    expect(
      evaluateCodeQuality(metrics, {
        maxComplexity: 1,
        maxFunctionLines: 2,
        maxLines: 2,
        maxNesting: 0,
        owner: 'test',
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: 'lineCount' }),
        expect.objectContaining({ metric: 'maxFunctionLines' }),
      ]),
    );
  });
});
