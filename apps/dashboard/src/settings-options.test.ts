import { describe, expect, it } from 'vitest';

import {
  PRESET_MODELS,
  buildModelOptions,
  effortValuesForAgent,
  formatEffortOption,
  isEffortSupported,
  isPresetModel,
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

describe('settings-options models', () => {
  it('offers Claude Opus 4.8 as the only Claude preset', () => {
    expect(PRESET_MODELS.claude).toEqual(['claude-opus-4-8']);
    expect(buildModelOptions('')).toContain('claude-opus-4-8');
    expect(isPresetModel('claude-opus-4-8')).toBe(true);
    expect(isPresetModel('claude-opus-4-7')).toBe(false);
    expect(isPresetModel('claude-opus-4-6')).toBe(false);
  });
});
