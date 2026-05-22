export function buildClaudeSdkEnv(
  baseEnv: Record<string, string | undefined>,
  secrets: Record<string, string> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv };
  for (const [key, value] of Object.entries(secrets)) {
    env[key] = value;
  }

  // Claude Agent SDK 0.3.x connects MCP servers in the background by default.
  // EJClaw expects its local MCP server to be available on the first turn.
  env.MCP_CONNECTION_NONBLOCKING ??= '0';

  return env;
}
