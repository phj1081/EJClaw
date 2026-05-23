import { describe, expect, it } from 'vitest';

import {
  effortValuesForAgent,
  formatEffortOption,
  isEffortSupported,
} from './settings-options';

describe('settings-options effort', () => {
  it('limits Claude agents to low through max without xhigh', () => {
    expect(effortValuesForAgent('claude-code')).toEqual([
      '',
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(isEffortSupported('claude-code', 'xhigh')).toBe(false);
    expect(isEffortSupported('claude-code', 'high')).toBe(true);
  });

  it('allows xhigh for Codex agents', () => {
    expect(effortValuesForAgent('codex')).toContain('xhigh');
    expect(isEffortSupported('codex', 'xhigh')).toBe(true);
  });

  it('shows raw effort keys beside localized labels', () => {
    expect(formatEffortOption('high', '높음')).toBe('높음 (high)');
    expect(formatEffortOption('', '기본값')).toBe('기본값');
  });
});
