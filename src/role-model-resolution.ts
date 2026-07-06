import type { RoleModelConfig } from './config/schema.js';
import type { AgentConfig } from './types.js';

export interface ResolvedRoleModelEnv {
  model?: string;
  effort?: string;
}

/**
 * Resolve the model/effort a role should run with.
 *
 * Precedence: room-level role override (room_role_overrides.agent_config_json)
 * beats the global OWNER_/REVIEWER_/ARBITER_ env configuration.
 */
export function resolveRoleModelEnv(args: {
  isClaudeCompatible: boolean;
  roomAgentConfig?: AgentConfig;
  globalRoleConfig: RoleModelConfig;
}): ResolvedRoleModelEnv {
  const roomModel = args.isClaudeCompatible
    ? args.roomAgentConfig?.claudeModel
    : args.roomAgentConfig?.codexModel;
  const roomEffort = args.isClaudeCompatible
    ? args.roomAgentConfig?.claudeEffort
    : args.roomAgentConfig?.codexEffort;

  return {
    model: roomModel || args.globalRoleConfig.model || undefined,
    effort: roomEffort || args.globalRoleConfig.effort || undefined,
  };
}
