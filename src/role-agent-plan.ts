import type { AgentType } from './types.js';

export interface RoleAgentPlan {
  ownerAgentType: AgentType;
  reviewerAgentType: AgentType | null;
  arbiterAgentType: AgentType | null;
}

export interface ResolveRoleAgentPlanArgs {
  paired: boolean;
  groupAgentType?: AgentType;
  configuredReviewer: AgentType;
  configuredArbiter?: AgentType | null;
}

/**
 * Preserve current runtime agent-resolution behavior in one pure helper.
 * This intentionally mirrors today's paired inference and does not read room mode yet.
 */
export function resolveRoleAgentPlan(
  args: ResolveRoleAgentPlanArgs,
): RoleAgentPlan {
  const ownerAgentType: AgentType = args.groupAgentType || 'claude-code';

  if (!args.paired) {
    return {
      ownerAgentType,
      reviewerAgentType: null,
      arbiterAgentType: null,
    };
  }

  return {
    ownerAgentType,
    reviewerAgentType:
      args.configuredReviewer !== ownerAgentType
        ? args.configuredReviewer
        : ownerAgentType,
    arbiterAgentType: args.configuredArbiter ?? null,
  };
}
