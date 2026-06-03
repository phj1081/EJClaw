export type CodexRuntimeMode = 'app-server' | 'sdk';

export interface CodexRuntimeModeInput {
  codexGoals?: boolean;
  roomRole?: string;
}

export interface CodexRuntimeModeResolution {
  mode: CodexRuntimeMode;
  reason:
    | 'default'
    | 'CODEX_RUNTIME=app-server'
    | 'CODEX_RUNTIME=sdk'
    | 'sdk-unsupported-goals'
    | 'sdk-unsupported-session-command'
    | 'sdk-role-not-enabled'
    | 'invalid-CODEX_RUNTIME';
}

function normalizeRuntimeMode(
  raw: string | undefined,
): CodexRuntimeMode | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'app-server' || normalized === 'appserver') {
    return 'app-server';
  }
  if (normalized === 'sdk') {
    return 'sdk';
  }
  return null;
}

export interface CodexRuntimeEnv {
  [key: string]: string | undefined;
  CODEX_RUNTIME?: string;
  CODEX_RUNTIME_SDK_ROLES?: string;
}

function sdkRoleEnabled(
  env: CodexRuntimeEnv,
  roomRole: string | undefined,
): boolean {
  const raw = env.CODEX_RUNTIME_SDK_ROLES?.trim();
  if (!raw) return true;
  if (!roomRole) return false;
  const allowed = raw
    .split(',')
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(roomRole.trim().toLowerCase());
}

export function resolveCodexRuntimeMode(
  env: CodexRuntimeEnv,
  input: CodexRuntimeModeInput,
  rawPrompt: string,
): CodexRuntimeModeResolution {
  const requested = normalizeRuntimeMode(env.CODEX_RUNTIME);
  if (requested === 'sdk') {
    if (rawPrompt.trim() === '/compact') {
      return {
        mode: 'app-server',
        reason: 'sdk-unsupported-session-command',
      };
    }
    if (input.codexGoals === true) {
      return { mode: 'app-server', reason: 'sdk-unsupported-goals' };
    }
    if (!sdkRoleEnabled(env, input.roomRole)) {
      return { mode: 'app-server', reason: 'sdk-role-not-enabled' };
    }
    return { mode: 'sdk', reason: 'CODEX_RUNTIME=sdk' };
  }

  if (requested === 'app-server') {
    return { mode: 'app-server', reason: 'CODEX_RUNTIME=app-server' };
  }

  if (env.CODEX_RUNTIME && env.CODEX_RUNTIME.trim()) {
    return { mode: 'app-server', reason: 'invalid-CODEX_RUNTIME' };
  }

  return { mode: 'app-server', reason: 'default' };
}
