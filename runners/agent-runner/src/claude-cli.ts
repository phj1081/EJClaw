import { resolveBundledClaudeCodeExecutable } from './bundled-cli-path.js';

let cachedClaudeCliPath: string | null = null;

export function getClaudeCliPath(log: (message: string) => void): string {
  if (cachedClaudeCliPath) return cachedClaudeCliPath;
  cachedClaudeCliPath = resolveBundledClaudeCodeExecutable();
  log(`Resolved bundled Claude Code CLI: ${cachedClaudeCliPath}`);
  return cachedClaudeCliPath;
}
