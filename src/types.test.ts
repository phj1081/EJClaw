import { describe, expect, it } from 'vitest';

import { normalizeAgentOutputPhase, toVisiblePhase } from './types.js';

describe('phase helpers', () => {
  it('maps agent output phases to visible phases', () => {
    expect(toVisiblePhase('intermediate')).toBe('silent');
    expect(toVisiblePhase('tool-activity')).toBe('silent');
    expect(toVisiblePhase('progress')).toBe('progress');
    expect(toVisiblePhase('final')).toBe('final');
  });

  it('normalizes missing agent output phases to final', () => {
    expect(normalizeAgentOutputPhase(undefined)).toBe('final');
    expect(normalizeAgentOutputPhase('progress')).toBe('progress');
  });
});
