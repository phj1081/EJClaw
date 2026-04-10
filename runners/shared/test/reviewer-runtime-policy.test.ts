import { describe, expect, it } from 'vitest';

import {
  buildPairedReadonlyRuntimeEnvOverrides,
  getReviewerRuntimeCapabilities,
} from '../src/reviewer-runtime-policy.js';

describe('shared reviewer runtime policy', () => {
  it('encodes claude reviewer capabilities explicitly', () => {
    expect(getReviewerRuntimeCapabilities('claude-code')).toEqual({
      agentType: 'claude-code',
      supportsShellPreflightHook: true,
      supportsReadonlySandboxing: true,
      supportsGitWriteGuard: true,
      supportsHardMutationBlocking: true,
    });
  });

  it('encodes codex reviewer limitations explicitly', () => {
    expect(getReviewerRuntimeCapabilities('codex')).toEqual({
      agentType: 'codex',
      supportsShellPreflightHook: false,
      supportsReadonlySandboxing: false,
      supportsGitWriteGuard: true,
      supportsHardMutationBlocking: false,
    });
  });

  it('builds reviewer runtime env for normal isolated runs', () => {
    expect(
      buildPairedReadonlyRuntimeEnvOverrides({
        role: 'reviewer',
        agentType: 'claude-code',
        unsafeHostPairedMode: false,
      }),
    ).toEqual({
      EJCLAW_REVIEWER_RUNTIME: '1',
    });
  });

  it('builds claude host reviewer env with explicit readonly flag', () => {
    expect(
      buildPairedReadonlyRuntimeEnvOverrides({
        role: 'reviewer',
        agentType: 'claude-code',
        unsafeHostPairedMode: true,
      }),
    ).toEqual({
      EJCLAW_UNSAFE_HOST_PAIRED_MODE: '1',
      EJCLAW_CLAUDE_REVIEWER_READONLY: '1',
    });
  });

  it('leaves codex host reviewer mode without fake hard-block flags', () => {
    expect(
      buildPairedReadonlyRuntimeEnvOverrides({
        role: 'reviewer',
        agentType: 'codex',
        unsafeHostPairedMode: true,
      }),
    ).toEqual({
      EJCLAW_UNSAFE_HOST_PAIRED_MODE: '1',
    });
  });

  it('keeps arbiter runtime routing unchanged', () => {
    expect(
      buildPairedReadonlyRuntimeEnvOverrides({
        role: 'arbiter',
        agentType: 'claude-code',
        unsafeHostPairedMode: false,
      }),
    ).toEqual({
      EJCLAW_ARBITER_RUNTIME: '1',
    });
  });
});
