import { describe, expect, it } from 'vitest';

import {
  readCodexFeatureFromContent,
  writeCodexFeatureInContent,
} from './codex-config-features.js';

describe('codex-config-features', () => {
  it('reads feature flags from the [features] section', () => {
    const toml = `
model = "gpt-5.5"

[features]
fast_mode = true
goals = false
`;
    expect(readCodexFeatureFromContent(toml, 'fast_mode')).toBe(true);
    expect(readCodexFeatureFromContent(toml, 'goals')).toBe(false);
  });

  it('writes missing feature flags into [features]', () => {
    const updated = writeCodexFeatureInContent(
      'model = "gpt-5.5"\n',
      'goals',
      true,
    );
    expect(updated).toContain('[features]');
    expect(updated).toContain('goals = true');
  });
});
