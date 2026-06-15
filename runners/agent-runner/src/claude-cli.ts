import {
  resolveClaudeCompatibleExecutable,
  type ClaudeCompatibleAgentType,
} from './bundled-cli-path.js';

const cachedCliPaths = new Map<ClaudeCompatibleAgentType, string>();

export function getClaudeCliPath(
  log: (message: string) => void,
  agentType: ClaudeCompatibleAgentType = 'claude-code',
): string {
  const cached = cachedCliPaths.get(agentType);
  if (cached) return cached;
  const resolved = resolveClaudeCompatibleExecutable({ agentType });
  cachedCliPaths.set(agentType, resolved);
  log(
    agentType === 'glm-code'
      ? `Resolved GLM Code CLI: ${resolved}`
      : `Resolved bundled Claude Code CLI: ${resolved}`,
  );
  return resolved;
}
