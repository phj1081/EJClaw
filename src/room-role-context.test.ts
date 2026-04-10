import { describe, expect, it } from 'vitest';

import { buildRoomRoleContext } from './room-role-context.js';

describe('buildRoomRoleContext', () => {
  it('returns reviewer context for a normal paired codex turn', () => {
    expect(
      buildRoomRoleContext(
        {
          chat_jid: 'group@test',
          owner_service_id: 'claude',
          reviewer_service_id: 'codex-main',
          arbiter_service_id: null,
          owner_failover_active: false,
          activated_at: null,
          reason: null,
          explicit: false,
        },
        'codex-main',
      ),
    ).toEqual({
      serviceId: 'codex-main',
      role: 'reviewer',
      ownerServiceId: 'claude',
      reviewerServiceId: 'codex-main',
      failoverOwner: false,
      arbiterServiceId: undefined,
    });
  });

  it('uses the stored reviewer service id from the lease row as-is', () => {
    expect(
      buildRoomRoleContext(
        {
          chat_jid: 'group@test',
          owner_agent_type: 'claude-code',
          reviewer_agent_type: 'codex',
          owner_service_id: 'claude',
          reviewer_service_id: 'stale-reviewer-shadow',
          arbiter_service_id: null,
          owner_failover_active: false,
          activated_at: null,
          reason: null,
          explicit: true,
        },
        'stale-reviewer-shadow',
      ),
    ).toEqual({
      serviceId: 'stale-reviewer-shadow',
      role: 'reviewer',
      ownerServiceId: 'claude',
      reviewerServiceId: 'stale-reviewer-shadow',
      ownerAgentType: 'claude-code',
      reviewerAgentType: 'codex',
      failoverOwner: false,
      arbiterServiceId: undefined,
    });
  });

  it('returns owner failover context from the explicit owner failover flag', () => {
    expect(
      buildRoomRoleContext(
        {
          chat_jid: 'group@test',
          owner_agent_type: 'claude-code',
          reviewer_agent_type: 'claude-code',
          owner_service_id: 'codex-review',
          reviewer_service_id: 'claude',
          arbiter_service_id: null,
          owner_failover_active: true,
          activated_at: '2026-03-28T10:00:00.000Z',
          reason: 'claude-429',
          explicit: true,
        },
        'codex-review',
      ),
    ).toEqual({
      serviceId: 'codex-review',
      role: 'owner',
      ownerServiceId: 'codex-review',
      reviewerServiceId: 'claude',
      ownerAgentType: 'claude-code',
      reviewerAgentType: 'claude-code',
      failoverOwner: true,
      arbiterServiceId: undefined,
    });
  });

  it('returns arbiter context when service matches arbiter_service_id', () => {
    expect(
      buildRoomRoleContext(
        {
          chat_jid: 'group@test',
          owner_service_id: 'codex-main',
          reviewer_service_id: 'claude',
          arbiter_service_id: 'codex-review',
          owner_failover_active: false,
          activated_at: null,
          reason: null,
          explicit: false,
        },
        'codex-review',
      ),
    ).toEqual({
      serviceId: 'codex-review',
      role: 'arbiter',
      ownerServiceId: 'codex-main',
      reviewerServiceId: 'claude',
      failoverOwner: false,
      arbiterServiceId: 'codex-review',
    });
  });

  it('uses the preferred reviewer role when owner and reviewer share the same service', () => {
    expect(
      buildRoomRoleContext(
        {
          chat_jid: 'group@test',
          owner_service_id: 'claude',
          reviewer_service_id: 'claude',
          arbiter_service_id: null,
          owner_failover_active: false,
          activated_at: null,
          reason: null,
          explicit: false,
        },
        'claude',
        'reviewer',
      ),
    ).toEqual({
      serviceId: 'claude',
      role: 'reviewer',
      ownerServiceId: 'claude',
      reviewerServiceId: 'claude',
      failoverOwner: false,
      arbiterServiceId: undefined,
    });
  });

  it('keeps the preferred reviewer role when fallback execution shares the arbiter service shadow', () => {
    expect(
      buildRoomRoleContext(
        {
          chat_jid: 'group@test',
          owner_service_id: 'codex-main',
          reviewer_service_id: 'claude',
          arbiter_service_id: 'codex-review',
          owner_failover_active: false,
          activated_at: null,
          reason: null,
          explicit: false,
        },
        'codex-review',
        'reviewer',
      ),
    ).toEqual({
      serviceId: 'codex-review',
      role: 'reviewer',
      ownerServiceId: 'codex-main',
      reviewerServiceId: 'claude',
      failoverOwner: false,
      arbiterServiceId: 'codex-review',
    });
  });

  it('returns undefined for a non-paired room', () => {
    expect(
      buildRoomRoleContext(
        {
          chat_jid: 'solo@test',
          owner_service_id: 'codex-main',
          reviewer_service_id: null,
          arbiter_service_id: null,
          owner_failover_active: false,
          activated_at: null,
          reason: null,
          explicit: false,
        },
        'codex-main',
      ),
    ).toBeUndefined();
  });
});
