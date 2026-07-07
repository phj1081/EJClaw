import type { RoleModelConfig } from './config/schema.js';
import type { AgentConfig, AgentType } from './types.js';
import { isClaudeCompatibleAgentType } from './types.js';

export interface ResolvedRoleModelEnv {
  model?: string;
  effort?: string;
}

/**
 * Resolve the model/effort a role should run with.
 *
 * Precedence: room-level role override (room_role_overrides.agent_config_json)
 * beats the global OWNER_/REVIEWER_/ARBITER_ env configuration.
 *
 * Compatibility guard: the global role config (e.g. REVIEWER_MODEL) is written
 * for the globally configured agent type of that role (e.g.
 * REVIEWER_AGENT_TYPE). When the effective agent executing the turn belongs to
 * a different model family (claude-compatible vs codex), applying the global
 * model would inject an invalid model name into the wrong runner — e.g.
 * CLAUDE_MODEL=gpt-5.5 producing "There's an issue with the selected model".
 * In that case the global model/effort are ignored and the runner falls back
 * to its own default model. Room-level overrides are unaffected because they
 * are already keyed per family (claudeModel/codexModel).
 */
export function resolveRoleModelEnv(args: {
  isClaudeCompatible: boolean;
  roomAgentConfig?: AgentConfig;
  globalRoleConfig: RoleModelConfig;
  /**
   * The globally configured agent type for this role (OWNER_/REVIEWER_/
   * ARBITER_AGENT_TYPE). When provided and its model family does not match
   * the effective agent, the global model/effort are not applied.
   */
  globalRoleAgentType?: AgentType | null;
}): ResolvedRoleModelEnv {
  const roomModel = args.isClaudeCompatible
    ? args.roomAgentConfig?.claudeModel
    : args.roomAgentConfig?.codexModel;
  const roomEffort = args.isClaudeCompatible
    ? args.roomAgentConfig?.claudeEffort
    : args.roomAgentConfig?.codexEffort;

  const globalCompatible =
    args.globalRoleAgentType == null ||
    isClaudeCompatibleAgentType(args.globalRoleAgentType) ===
      args.isClaudeCompatible;

  const globalModel = globalCompatible
    ? args.globalRoleConfig.model
    : undefined;
  const globalEffort = globalCompatible
    ? args.globalRoleConfig.effort
    : undefined;

  return {
    model: roomModel || globalModel || undefined,
    effort: roomEffort || globalEffort || undefined,
  };
}
