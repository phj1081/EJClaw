import { describe, expect, it } from 'vitest';

import { resolveCodexRuntimeMode } from '../src/runtime-mode.js';

describe('codex runner runtime mode selection', () => {
  it('keeps app-server as the default runtime', () => {
    expect(
      resolveCodexRuntimeMode({}, { codexGoals: false }, 'do work'),
    ).toEqual({
      mode: 'app-server',
      reason: 'default',
    });
  });

  it('selects SDK mode when CODEX_RUNTIME=sdk', () => {
    expect(
      resolveCodexRuntimeMode(
        { CODEX_RUNTIME: 'sdk' },
        { codexGoals: false },
        'do work',
      ),
    ).toEqual({ mode: 'sdk', reason: 'CODEX_RUNTIME=sdk' });
  });

  it('canary-limits SDK mode to configured paired roles', () => {
    expect(
      resolveCodexRuntimeMode(
        { CODEX_RUNTIME: 'sdk', CODEX_RUNTIME_SDK_ROLES: 'owner,arbiter' },
        { codexGoals: false, roomRole: 'owner' },
        'do work',
      ),
    ).toEqual({ mode: 'sdk', reason: 'CODEX_RUNTIME=sdk' });
    expect(
      resolveCodexRuntimeMode(
        { CODEX_RUNTIME: 'sdk', CODEX_RUNTIME_SDK_ROLES: 'owner,arbiter' },
        { codexGoals: false, roomRole: 'reviewer' },
        'do work',
      ),
    ).toEqual({ mode: 'app-server', reason: 'sdk-role-not-enabled' });
  });

  it('falls back to app-server for /compact because SDK lacks compaction', () => {
    expect(
      resolveCodexRuntimeMode(
        { CODEX_RUNTIME: 'sdk' },
        { codexGoals: false },
        '/compact',
      ),
    ).toEqual({
      mode: 'app-server',
      reason: 'sdk-unsupported-session-command',
    });
  });

  it('falls back to app-server when Codex goals are enabled', () => {
    expect(
      resolveCodexRuntimeMode(
        { CODEX_RUNTIME: 'sdk' },
        { codexGoals: true },
        'do work',
      ),
    ).toEqual({ mode: 'app-server', reason: 'sdk-unsupported-goals' });
  });
});
