import { describe, expect, it } from 'vitest';

import { resolveCodexFallbackHandoff } from './paired-turn-fallback.js';

describe('resolveCodexFallbackHandoff', () => {
  it('returns a reviewer codex handoff plan for reviewer auth failures', () => {
    const result = resolveCodexFallbackHandoff({
      activeRole: 'reviewer',
      effectiveAgentType: 'claude-code',
      hasReviewer: true,
      fallbackEnabled: true,
      reason: 'auth-expired',
      sawVisibleOutput: false,
      prompt: 'please review',
      startSeq: 10,
      endSeq: 12,
    });

    expect(result).toEqual({
      type: 'handoff',
      plan: {
        handoff: {
          source_role: 'reviewer',
          target_role: 'reviewer',
          source_agent_type: 'claude-code',
          target_agent_type: 'codex',
          prompt: 'please review',
          start_seq: 10,
          end_seq: 12,
          reason: 'reviewer-claude-auth-expired',
          intended_role: 'reviewer',
        },
        logMessage:
          'Claude reviewer unavailable, handed off review turn to codex-review',
      },
    });
  });

  it('returns an arbiter codex handoff plan for arbiter auth failures', () => {
    const result = resolveCodexFallbackHandoff({
      activeRole: 'arbiter',
      effectiveAgentType: 'claude-code',
      hasReviewer: true,
      fallbackEnabled: true,
      reason: '429',
      sawVisibleOutput: false,
      prompt: 'please arbitrate',
    });

    expect(result).toEqual({
      type: 'handoff',
      plan: {
        handoff: {
          source_role: 'arbiter',
          target_role: 'arbiter',
          source_agent_type: 'claude-code',
          target_agent_type: 'codex',
          prompt: 'please arbitrate',
          start_seq: null,
          end_seq: null,
          reason: 'arbiter-claude-429',
          intended_role: 'arbiter',
        },
        logMessage:
          'Claude arbiter unavailable, handed off arbiter turn to codex',
      },
    });
  });

  it('returns an owner codex handoff plan and failover activation for owner failures', () => {
    const result = resolveCodexFallbackHandoff({
      activeRole: 'owner',
      effectiveAgentType: 'claude-code',
      hasReviewer: true,
      fallbackEnabled: true,
      reason: 'session-failure',
      sawVisibleOutput: false,
      prompt: 'please continue',
    });

    expect(result).toEqual({
      type: 'handoff',
      plan: {
        handoff: {
          source_role: 'owner',
          target_role: 'owner',
          source_agent_type: 'claude-code',
          target_agent_type: 'codex',
          prompt: 'please continue',
          start_seq: null,
          end_seq: null,
          reason: 'claude-session-failure',
          intended_role: 'owner',
        },
        activateOwnerFailoverReason: 'claude-session-failure',
        logMessage:
          'Claude unavailable, handed off current owner turn to codex fallback',
      },
    });
  });

  it('skips handoff when fallback is disabled for the role', () => {
    const result = resolveCodexFallbackHandoff({
      activeRole: 'owner',
      effectiveAgentType: 'claude-code',
      hasReviewer: true,
      fallbackEnabled: false,
      reason: 'usage-exhausted',
      sawVisibleOutput: false,
      prompt: 'please continue',
    });

    expect(result).toEqual({
      type: 'skip',
      logMessage: 'Fallback disabled for role, skipping handoff',
    });
  });

  it('returns none when visible output was already emitted', () => {
    const result = resolveCodexFallbackHandoff({
      activeRole: 'reviewer',
      effectiveAgentType: 'claude-code',
      hasReviewer: true,
      fallbackEnabled: true,
      reason: 'auth-expired',
      sawVisibleOutput: true,
      prompt: 'please review',
    });

    expect(result).toEqual({ type: 'none' });
  });

  it('returns none when no reviewer is configured for the room', () => {
    const result = resolveCodexFallbackHandoff({
      activeRole: 'owner',
      effectiveAgentType: 'claude-code',
      hasReviewer: false,
      fallbackEnabled: true,
      reason: '429',
      sawVisibleOutput: false,
      prompt: 'please continue',
    });

    expect(result).toEqual({ type: 'none' });
  });
});
