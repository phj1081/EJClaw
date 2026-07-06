import { describe, expect, it } from 'vitest';

import { resolveRoleModelEnv } from './role-model-resolution.js';

describe('resolveRoleModelEnv', () => {
  it('prefers the room-level role override over the global role config', () => {
    expect(
      resolveRoleModelEnv({
        isClaudeCompatible: true,
        roomAgentConfig: { claudeModel: 'claude-room', claudeEffort: 'max' },
        globalRoleConfig: {
          model: 'claude-global',
          effort: 'low',
          fallbackEnabled: true,
        },
      }),
    ).toEqual({ model: 'claude-room', effort: 'max' });
  });

  it('falls back to the global config when the room has no override', () => {
    expect(
      resolveRoleModelEnv({
        isClaudeCompatible: false,
        roomAgentConfig: undefined,
        globalRoleConfig: {
          model: 'gpt-global',
          effort: 'high',
          fallbackEnabled: true,
        },
      }),
    ).toEqual({ model: 'gpt-global', effort: 'high' });
  });

  it('reads the codex keys for codex agents even when claude keys are set', () => {
    expect(
      resolveRoleModelEnv({
        isClaudeCompatible: false,
        roomAgentConfig: {
          claudeModel: 'claude-room',
          codexModel: 'gpt-room',
        },
        globalRoleConfig: {
          model: 'gpt-global',
          effort: undefined,
          fallbackEnabled: true,
        },
      }),
    ).toEqual({ model: 'gpt-room', effort: undefined });
  });

  it('mixes room and global values per field', () => {
    expect(
      resolveRoleModelEnv({
        isClaudeCompatible: true,
        roomAgentConfig: { claudeModel: 'claude-room' },
        globalRoleConfig: {
          model: undefined,
          effort: 'medium',
          fallbackEnabled: true,
        },
      }),
    ).toEqual({ model: 'claude-room', effort: 'medium' });
  });

  it('returns undefined when neither room nor global values exist', () => {
    expect(
      resolveRoleModelEnv({
        isClaudeCompatible: true,
        roomAgentConfig: undefined,
        globalRoleConfig: {
          model: undefined,
          effort: undefined,
          fallbackEnabled: true,
        },
      }),
    ).toEqual({ model: undefined, effort: undefined });
  });
});
