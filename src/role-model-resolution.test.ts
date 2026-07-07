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

  it('ignores the global model when the effective agent family differs from the configured role agent type (codex model must not leak into a claude runner)', () => {
    // Regression: channel_owner routed the reviewer to claude-code while
    // REVIEWER_AGENT_TYPE=codex / REVIEWER_MODEL=gpt-5.5 — the codex model
    // was injected as CLAUDE_MODEL and the Claude CLI rejected it.
    expect(
      resolveRoleModelEnv({
        isClaudeCompatible: true,
        roomAgentConfig: undefined,
        globalRoleConfig: {
          model: 'gpt-5.5',
          effort: 'high',
          fallbackEnabled: true,
        },
        globalRoleAgentType: 'codex',
      }),
    ).toEqual({ model: undefined, effort: undefined });
  });

  it('ignores the global model when a claude model would leak into a codex runner', () => {
    expect(
      resolveRoleModelEnv({
        isClaudeCompatible: false,
        roomAgentConfig: undefined,
        globalRoleConfig: {
          model: 'claude-fable-5',
          effort: 'max',
          fallbackEnabled: true,
        },
        globalRoleAgentType: 'claude-code',
      }),
    ).toEqual({ model: undefined, effort: undefined });
  });

  it('applies the global model when the configured role agent type matches the effective agent family', () => {
    expect(
      resolveRoleModelEnv({
        isClaudeCompatible: false,
        roomAgentConfig: undefined,
        globalRoleConfig: {
          model: 'gpt-5.5',
          effort: 'high',
          fallbackEnabled: true,
        },
        globalRoleAgentType: 'codex',
      }),
    ).toEqual({ model: 'gpt-5.5', effort: 'high' });
  });

  it('treats glm-code as claude-compatible for the global model guard', () => {
    expect(
      resolveRoleModelEnv({
        isClaudeCompatible: true,
        roomAgentConfig: undefined,
        globalRoleConfig: {
          model: 'glm-5.2',
          effort: undefined,
          fallbackEnabled: true,
        },
        globalRoleAgentType: 'glm-code',
      }),
    ).toEqual({ model: 'glm-5.2', effort: undefined });
  });

  it('still applies a mismatched-family room override untouched (room config is keyed per family)', () => {
    expect(
      resolveRoleModelEnv({
        isClaudeCompatible: true,
        roomAgentConfig: { claudeModel: 'claude-room' },
        globalRoleConfig: {
          model: 'gpt-5.5',
          effort: 'high',
          fallbackEnabled: true,
        },
        globalRoleAgentType: 'codex',
      }),
    ).toEqual({ model: 'claude-room', effort: undefined });
  });

  it('keeps legacy behavior when the global role agent type is unknown', () => {
    expect(
      resolveRoleModelEnv({
        isClaudeCompatible: true,
        roomAgentConfig: undefined,
        globalRoleConfig: {
          model: 'claude-global',
          effort: 'low',
          fallbackEnabled: true,
        },
        globalRoleAgentType: undefined,
      }),
    ).toEqual({ model: 'claude-global', effort: 'low' });
  });
});
