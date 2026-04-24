import { describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    REVIEWER_AGENT_TYPE: actual.REVIEWER_AGENT_TYPE ?? 'claude-code',
    ARBITER_AGENT_TYPE: undefined,
  };
});

import {
  matchesExpectedPairedFollowUpIntent,
  resolveFollowUpDispatch,
  resolveExecutionTarget,
  resolveQueuedPairedTurnRole,
  resolveNextTurnAction,
  resolveQueuedTurnRole,
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

  it('rejects stale reviewer and finalize follow-ups once the latest persisted turn already closed that handoff', () => {
    expect(
      matchesExpectedPairedFollowUpIntent({
        taskStatus: 'review_ready',
        lastTurnOutputRole: 'reviewer',
        intentKind: 'reviewer-turn',
      }),
    ).toBe(false);
    expect(
      matchesExpectedPairedFollowUpIntent({
        taskStatus: 'merge_ready',
        lastTurnOutputRole: 'owner',
        intentKind: 'finalize-owner-turn',
      }),
    ).toBe(false);
  });

  it('keeps owner follow-ups schedulable when reviewer or arbiter is still the latest persisted turn', () => {
    expect(
      matchesExpectedPairedFollowUpIntent({
        taskStatus: 'active',
        lastTurnOutputRole: 'reviewer',
        intentKind: 'owner-follow-up',
      }),
    ).toBe(true);
    expect(
      matchesExpectedPairedFollowUpIntent({
        taskStatus: 'active',
        lastTurnOutputRole: 'arbiter',
        intentKind: 'owner-follow-up',
      }),
    ).toBe(true);
    expect(
      matchesExpectedPairedFollowUpIntent({
        taskStatus: 'active',
        lastTurnOutputRole: 'owner',
        lastTurnOutputVerdict: 'step_done',
        intentKind: 'owner-follow-up',
      }),
    ).toBe(false);
  });

  it('maps active tasks with reviewer output to an owner follow-up', () => {
    expect(
      resolveNextTurnAction({
        taskStatus: 'active',
        lastTurnOutputRole: 'reviewer',
      }),
    ).toEqual({ kind: 'owner-follow-up' });
  });

  it('does not map active owner STEP_DONE output to an owner follow-up', () => {
    expect(
      resolveNextTurnAction({
        taskStatus: 'active',
        lastTurnOutputRole: 'owner',
        lastTurnOutputVerdict: 'step_done',
      }),
    ).toEqual({ kind: 'none' });
  });

  it('returns none when an active task has no reviewer or arbiter handoff output', () => {
    expect(
      resolveNextTurnAction({
        taskStatus: 'active',
        lastTurnOutputRole: 'owner',
      }),
    ).toEqual({ kind: 'none' });
  });

  it('dispatches owner delivery success through a paired follow-up enqueue for reviewer or arbiter turns', () => {
    expect(
      resolveFollowUpDispatch({
        source: 'owner-delivery-success',
        nextTurnAction: { kind: 'reviewer-turn' },
      }),
    ).toEqual({
      kind: 'enqueue',
      queueKind: 'paired-follow-up',
    });
    expect(
      resolveFollowUpDispatch({
        source: 'owner-delivery-success',
        nextTurnAction: { kind: 'arbiter-turn' },
      }),
    ).toEqual({
      kind: 'enqueue',
      queueKind: 'paired-follow-up',
    });
    expect(
      resolveFollowUpDispatch({
        source: 'owner-delivery-success',
        nextTurnAction: { kind: 'owner-follow-up' },
      }),
    ).toEqual({
      kind: 'enqueue',
      queueKind: 'paired-follow-up',
    });
    expect(
      resolveFollowUpDispatch({
        source: 'owner-delivery-success',
        nextTurnAction: { kind: 'none' },
      }),
    ).toEqual({ kind: 'none' });
  });

  it('dispatches failed owner recovery through a paired follow-up when execution escalated to arbiter', () => {
    expect(
      resolveFollowUpDispatch({
        source: 'executor-recovery',
        nextTurnAction: { kind: 'arbiter-turn' },
        completedRole: 'owner',
        executionStatus: 'failed',
        sawOutput: false,
      }),
    ).toEqual({
      kind: 'enqueue',
      queueKind: 'paired-follow-up',
    });
  });

  it('dispatches reviewer and arbiter delivery success through paired follow-up enqueue when a handoff is pending', () => {
    expect(
      resolveFollowUpDispatch({
        source: 'delivery-success',
        nextTurnAction: { kind: 'owner-follow-up' },
        completedRole: 'reviewer',
      }),
    ).toEqual({
      kind: 'enqueue',
      queueKind: 'paired-follow-up',
    });
    expect(
      resolveFollowUpDispatch({
        source: 'delivery-success',
        nextTurnAction: { kind: 'finalize-owner-turn' },
        completedRole: 'reviewer',
      }),
    ).toEqual({
      kind: 'enqueue',
      queueKind: 'paired-follow-up',
    });
    expect(
      resolveFollowUpDispatch({
        source: 'delivery-success',
        nextTurnAction: { kind: 'owner-follow-up' },
        completedRole: 'arbiter',
      }),
    ).toEqual({
      kind: 'enqueue',
      queueKind: 'paired-follow-up',
    });
  });

  it('dispatches delivery retry follow-ups through either generic message checks or paired follow-up enqueue', () => {
    expect(
      resolveFollowUpDispatch({
        source: 'delivery-retry',
        nextTurnAction: { kind: 'none' },
        completedRole: 'owner',
      }),
    ).toEqual({
      kind: 'enqueue',
      queueKind: 'message-check',
    });
    expect(
      resolveFollowUpDispatch({
        source: 'delivery-retry',
        nextTurnAction: { kind: 'reviewer-turn' },
        completedRole: 'owner',
      }),
    ).toEqual({
      kind: 'enqueue',
      queueKind: 'paired-follow-up',
    });
    expect(
      resolveFollowUpDispatch({
        source: 'delivery-retry',
        nextTurnAction: { kind: 'finalize-owner-turn' },
        completedRole: 'reviewer',
      }),
    ).toEqual({
      kind: 'enqueue',
      queueKind: 'paired-follow-up',
    });
  });

  it('dispatches bot-only follow-ups through inline finalize or paired enqueue', () => {
    expect(
      resolveFollowUpDispatch({
        source: 'bot-only-follow-up',
        nextTurnAction: { kind: 'finalize-owner-turn' },
      }),
    ).toEqual({ kind: 'inline' });
    expect(
      resolveFollowUpDispatch({
        source: 'bot-only-follow-up',
        nextTurnAction: { kind: 'owner-follow-up' },
      }),
    ).toEqual({
      kind: 'enqueue',
      queueKind: 'paired-follow-up',
    });
  });

  it('routes fresh human input to owner while review is pending or running', () => {
    expect(
      resolveQueuedTurnRole({
        taskStatus: 'review_ready',
        hasHumanMessage: true,
      }),
    ).toBe('owner');
    expect(
      resolveQueuedTurnRole({
        taskStatus: 'in_review',
        hasHumanMessage: true,
      }),
    ).toBe('owner');
    expect(
      resolveQueuedTurnRole({
        taskStatus: 'review_ready',
        hasHumanMessage: false,
      }),
    ).toBe('reviewer');
  });

  it('suppresses queued reviewer reruns when the latest persisted turn already belongs to the reviewer', () => {
    expect(
      resolveQueuedPairedTurnRole({
        taskStatus: 'review_ready',
        hasHumanMessage: false,
        lastTurnOutputRole: 'reviewer',
      }),
    ).toBeNull();
    expect(
      resolveQueuedPairedTurnRole({
        taskStatus: 'review_ready',
        hasHumanMessage: false,
        lastTurnOutputRole: 'owner',
      }),
    ).toBe('reviewer');
    expect(
      resolveQueuedPairedTurnRole({
        taskStatus: 'active',
        hasHumanMessage: false,
        lastTurnOutputRole: 'owner',
        lastTurnOutputVerdict: 'step_done',
      }),
    ).toBeNull();
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

  it('uses lease reviewer metadata when the room reviewer differs from the owner agent type', () => {
    const resolution = resolveExecutionTarget({
      lease: {
        ...baseLease,
        owner_agent_type: 'claude-code',
        reviewer_agent_type: 'codex',
        reviewer_service_id: 'codex-review',
      },
      pairedTaskStatus: 'review_ready',
      groupFolder: 'group-1',
      groupAgentType: 'claude-code',
    });

    expect(resolution).toMatchObject({
      activeRole: 'reviewer',
      configuredAgentType: 'codex',
      effectiveAgentType: 'codex',
      sessionFolder: 'group-1:reviewer',
    });
    expect(resolution.effectiveServiceId).toBe('codex-review');
  });

  it('resolves merge_ready execution target back to the owner/finalize path', () => {
    const resolution = resolveExecutionTarget({
      lease: baseLease,
      pairedTaskStatus: 'merge_ready',
      groupFolder: 'group-1',
      groupAgentType: 'claude-code',
    });

    expect(resolution).toMatchObject({
      inferredRole: 'owner',
      activeRole: 'owner',
      configuredAgentType: 'claude-code',
      effectiveAgentType: 'claude-code',
      sessionFolder: 'group-1',
    });
    expect(resolution.effectiveServiceId).toBe(
      resolveLeaseServiceId(baseLease, 'owner'),
    );
  });

  it('resolves arbiter execution target from arbiter_requested task status', () => {
    const resolution = resolveExecutionTarget({
      lease: baseLease,
      pairedTaskStatus: 'arbiter_requested',
      groupFolder: 'group-1',
      groupAgentType: 'claude-code',
    });

    expect(resolution).toMatchObject({
      inferredRole: 'arbiter',
      activeRole: 'arbiter',
      configuredAgentType: 'codex',
      effectiveAgentType: 'codex',
      sessionFolder: 'group-1:arbiter',
    });
    expect(resolution.effectiveServiceId).toBe(
      resolveLeaseServiceId(baseLease, 'arbiter'),
    );
  });

  it('uses lease arbiter metadata when the room arbiter differs from the owner agent type', () => {
    const resolution = resolveExecutionTarget({
      lease: {
        ...baseLease,
        owner_agent_type: 'codex',
        reviewer_agent_type: 'claude-code',
        reviewer_service_id: 'claude',
        arbiter_agent_type: 'claude-code',
        arbiter_service_id: 'claude',
      },
      pairedTaskStatus: 'arbiter_requested',
      groupFolder: 'group-1',
      groupAgentType: 'codex',
    });

    expect(resolution).toMatchObject({
      activeRole: 'arbiter',
      configuredAgentType: 'claude-code',
      effectiveAgentType: 'claude-code',
      sessionFolder: 'group-1:arbiter',
    });
    expect(resolution.effectiveServiceId).toBe('claude');
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
