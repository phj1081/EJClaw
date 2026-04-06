import { describe, expect, it } from 'vitest';

import {
  resolveExecutionTarget,
  resolveNextTurnAction,
  resolveSessionFolder,
} from './message-runtime-rules.js';
import {
  resolveLeaseServiceId,
  type EffectiveChannelLease,
} from './service-routing.js';

const baseLease: EffectiveChannelLease = {
  chat_jid: 'chat-1',
  owner_agent_type: 'claude-code',
  reviewer_agent_type: 'claude-code',
  arbiter_agent_type: 'codex',
  owner_service_id: 'svc-owner',
  reviewer_service_id: 'svc-reviewer',
  arbiter_service_id: 'svc-arbiter',
  owner_failover_active: false,
  activated_at: null,
  reason: null,
  explicit: true,
};

describe('message-runtime-rules', () => {
  it('maps review_ready to a reviewer turn', () => {
    expect(
      resolveNextTurnAction({
        taskStatus: 'review_ready',
      }),
    ).toEqual({ kind: 'reviewer-turn' });
  });

  it('maps arbiter_requested to an arbiter turn', () => {
    expect(
      resolveNextTurnAction({
        taskStatus: 'arbiter_requested',
      }),
    ).toEqual({ kind: 'arbiter-turn' });
  });

  it('maps merge_ready to an inline finalize owner turn', () => {
    expect(
      resolveNextTurnAction({
        taskStatus: 'merge_ready',
      }),
    ).toEqual({ kind: 'finalize-owner-turn' });
  });

  it('does not schedule a second reviewer turn when the latest turn already belongs to the reviewer', () => {
    expect(
      resolveNextTurnAction({
        taskStatus: 'review_ready',
        lastTurnOutputRole: 'reviewer',
      }),
    ).toEqual({ kind: 'none' });
  });

  it('does not schedule a second finalize turn when the latest turn already belongs to the owner', () => {
    expect(
      resolveNextTurnAction({
        taskStatus: 'merge_ready',
        lastTurnOutputRole: 'owner',
      }),
    ).toEqual({ kind: 'none' });
  });

  it('maps active tasks with reviewer output to an owner follow-up', () => {
    expect(
      resolveNextTurnAction({
        taskStatus: 'active',
        lastTurnOutputRole: 'reviewer',
      }),
    ).toEqual({ kind: 'owner-follow-up' });
  });

  it('returns none when an active task has no reviewer or arbiter handoff output', () => {
    expect(
      resolveNextTurnAction({
        taskStatus: 'active',
        lastTurnOutputRole: 'owner',
      }),
    ).toEqual({ kind: 'none' });
  });

  it('resolves reviewer execution target from review_ready task status', () => {
    const resolution = resolveExecutionTarget({
      lease: baseLease,
      pairedTaskStatus: 'review_ready',
      groupFolder: 'group-1',
      groupAgentType: 'claude-code',
    });

    expect(resolution).toMatchObject({
      inferredRole: 'reviewer',
      activeRole: 'reviewer',
      configuredAgentType: 'claude-code',
      effectiveAgentType: 'claude-code',
      sessionFolder: 'group-1',
    });
    expect(resolution.effectiveServiceId).toBe(resolution.reviewerServiceId);
  });

  it('honors an arbiter forced role only when arbiter is configured', () => {
    const resolution = resolveExecutionTarget({
      lease: {
        ...baseLease,
        arbiter_agent_type: null,
        arbiter_service_id: null,
      },
      pairedTaskStatus: 'active',
      groupFolder: 'group-1',
      groupAgentType: 'claude-code',
      forcedRole: 'arbiter',
    });

    expect(resolution).toMatchObject({
      inferredRole: 'owner',
      canHonorForcedRole: false,
      activeRole: 'owner',
    });
    expect(resolution.effectiveServiceId).toBe(
      resolveLeaseServiceId(baseLease, 'owner'),
    );
  });

  it('applies forced agent type overrides without changing the configured role target', () => {
    const resolution = resolveExecutionTarget({
      lease: baseLease,
      pairedTaskStatus: 'review_ready',
      groupFolder: 'group-1',
      groupAgentType: 'claude-code',
      forcedAgentType: 'codex',
    });

    expect(resolution).toMatchObject({
      activeRole: 'reviewer',
      configuredAgentType: 'claude-code',
      effectiveAgentType: 'codex',
    });
    expect(resolution.effectiveServiceId).toBe(resolution.reviewerServiceId);
  });

  it('always gives arbiter a dedicated session folder', () => {
    expect(resolveSessionFolder('group-1', 'arbiter', 'claude-code')).toBe(
      'group-1:arbiter',
    );
    expect(resolveSessionFolder('group-1', 'arbiter', 'codex')).toBe(
      'group-1:arbiter',
    );
  });
});
