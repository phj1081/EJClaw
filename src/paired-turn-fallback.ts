import type { AgentTriggerReason } from './agent-error-detection.js';
import type { AgentType, PairedRoomRole } from './types.js';

const CODEX_HANDOFF_REASONS = new Set<AgentTriggerReason>([
  '429',
  'usage-exhausted',
  'auth-expired',
  'org-access-denied',
  'session-failure',
]);

export interface CodexFallbackHandoffRecord {
  source_role: PairedRoomRole;
  target_role: PairedRoomRole;
  source_agent_type: AgentType;
  target_agent_type: 'codex';
  prompt: string;
  start_seq: number | null;
  end_seq: number | null;
  reason: string;
  intended_role: PairedRoomRole;
}

export interface CodexFallbackHandoffPlan {
  handoff: CodexFallbackHandoffRecord;
  activateOwnerFailoverReason?: string;
  logMessage: string;
}

export type CodexFallbackResolution =
  | { type: 'none' }
  | { type: 'skip'; logMessage: string }
  | { type: 'handoff'; plan: CodexFallbackHandoffPlan };

export function resolveCodexFallbackHandoff(args: {
  activeRole: PairedRoomRole;
  effectiveAgentType: AgentType;
  hasReviewer: boolean;
  fallbackEnabled: boolean;
  reason: AgentTriggerReason;
  sawVisibleOutput: boolean;
  prompt: string;
  startSeq?: number | null;
  endSeq?: number | null;
}): CodexFallbackResolution {
  if (args.sawVisibleOutput || !CODEX_HANDOFF_REASONS.has(args.reason)) {
    return { type: 'none' };
  }

  if (!args.hasReviewer) {
    return { type: 'none' };
  }

  if (!args.fallbackEnabled) {
    return {
      type: 'skip',
      logMessage: 'Fallback disabled for role, skipping handoff',
    };
  }

  const baseHandoff = {
    source_role: args.activeRole,
    source_agent_type: args.effectiveAgentType,
    target_agent_type: 'codex' as const,
    prompt: args.prompt,
    start_seq: args.startSeq ?? null,
    end_seq: args.endSeq ?? null,
  };

  if (args.activeRole === 'arbiter') {
    return {
      type: 'handoff',
      plan: {
        handoff: {
          ...baseHandoff,
          target_role: 'arbiter',
          intended_role: 'arbiter',
          reason: `arbiter-claude-${args.reason}`,
        },
        logMessage:
          'Claude arbiter unavailable, handed off arbiter turn to codex',
      },
    };
  }

  if (args.activeRole === 'reviewer') {
    return {
      type: 'handoff',
      plan: {
        handoff: {
          ...baseHandoff,
          target_role: 'reviewer',
          intended_role: 'reviewer',
          reason: `reviewer-claude-${args.reason}`,
        },
        logMessage:
          'Claude reviewer unavailable, handed off review turn to codex-review',
      },
    };
  }

  return {
    type: 'handoff',
    plan: {
      handoff: {
        ...baseHandoff,
        target_role: args.activeRole,
        intended_role: args.activeRole,
        reason: `claude-${args.reason}`,
      },
      activateOwnerFailoverReason: `claude-${args.reason}`,
      logMessage:
        'Claude unavailable, handed off current owner turn to codex fallback',
    },
  };
}
