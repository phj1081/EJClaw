import { beforeEach, describe, expect, it } from 'vitest';

import {
  _deleteStoredRoomSettingsForTests,
  _setRegisteredGroupForTests,
  _setStoredRoomOwnerAgentTypeForTests,
  _initTestDatabase,
  assignRoom,
  setChannelOwnerLease,
  setExplicitRoomMode,
} from './db.js';
import {
  activateCodexFailover,
  clearGlobalFailover,
  getEffectiveChannelLease,
  getGlobalFailoverInfo,
  refreshChannelOwnerCache,
  resolveLeaseServiceId,
} from './service-routing.js';

beforeEach(() => {
  _initTestDatabase();
  refreshChannelOwnerCache(true);
  clearGlobalFailover();
});

describe('service-routing global failover', () => {
  it('uses codex-review as owner during global failover without rewriting the reviewer lease', () => {
    _setRegisteredGroupForTests('dc:paired', {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:paired', {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    activateCodexFailover('dc:paired', 'claude-429');

    // Global failover applies to ALL channels
    expect(getGlobalFailoverInfo().active).toBe(true);
    expect(getEffectiveChannelLease('dc:paired')).toMatchObject({
      chat_jid: 'dc:paired',
      owner_service_id: 'codex-review',
      reviewer_service_id: 'claude',
      owner_failover_active: true,
      reason: 'claude-429',
      explicit: true,
    });
    // Any other channel is also affected
    expect(getEffectiveChannelLease('dc:other')).toMatchObject({
      owner_service_id: 'codex-review',
      reviewer_service_id: null,
      owner_failover_active: true,
      explicit: true,
    });
  });

  it('preserves reviewer and arbiter leases for tribunal rooms during global failover', () => {
    _setRegisteredGroupForTests('dc:tribunal', {
      name: 'Tribunal Room',
      folder: 'tribunal-room',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:tribunal', {
      name: 'Tribunal Room',
      folder: 'tribunal-room',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });
    setExplicitRoomMode('dc:tribunal', 'tribunal');
    const baseLease = getEffectiveChannelLease('dc:tribunal');

    activateCodexFailover('dc:tribunal', 'claude-429');

    expect(getEffectiveChannelLease('dc:tribunal')).toMatchObject({
      chat_jid: 'dc:tribunal',
      owner_service_id: 'codex-review',
      reviewer_service_id: baseLease.reviewer_service_id,
      arbiter_service_id: baseLease.arbiter_service_id,
      owner_failover_active: true,
      reason: 'claude-429',
      explicit: true,
    });
  });

  it('restores default lease after global failover is cleared', () => {
    _setRegisteredGroupForTests('dc:paired', {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:paired', {
      name: 'Paired Room',
      folder: 'paired-room',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });

    activateCodexFailover('dc:paired', 'claude-429');
    clearGlobalFailover();

    expect(getGlobalFailoverInfo().active).toBe(false);
    expect(getEffectiveChannelLease('dc:paired')).toMatchObject({
      chat_jid: 'dc:paired',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      owner_failover_active: false,
      explicit: false,
    });
  });

  it('uses explicit single room mode to suppress reviewer lease on dual registration', () => {
    _setRegisteredGroupForTests('dc:explicit-single', {
      name: 'Explicit Single',
      folder: 'explicit-single',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:explicit-single', {
      name: 'Explicit Single',
      folder: 'explicit-single',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });
    setExplicitRoomMode('dc:explicit-single', 'single');

    expect(getEffectiveChannelLease('dc:explicit-single')).toMatchObject({
      chat_jid: 'dc:explicit-single',
      owner_service_id: 'codex-main',
      reviewer_service_id: null,
      owner_failover_active: false,
      explicit: false,
    });
  });

  it('uses stored owner agent type when room_settings selects a different owner', () => {
    _setRegisteredGroupForTests('dc:stored-owner-claude', {
      name: 'Stored Owner Claude',
      folder: 'stored-owner-claude',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:stored-owner-claude', {
      name: 'Stored Owner Claude',
      folder: 'stored-owner-claude',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });
    setExplicitRoomMode('dc:stored-owner-claude', 'single');
    _setStoredRoomOwnerAgentTypeForTests(
      'dc:stored-owner-claude',
      'claude-code',
    );

    expect(getEffectiveChannelLease('dc:stored-owner-claude')).toMatchObject({
      chat_jid: 'dc:stored-owner-claude',
      owner_service_id: 'claude',
      reviewer_service_id: null,
      owner_failover_active: false,
      explicit: false,
    });
  });

  it('trusts stored owner agent type over incomplete legacy capability rows', () => {
    _setRegisteredGroupForTests('dc:stored-owner-fallback', {
      name: 'Stored Owner Fallback',
      folder: 'stored-owner-fallback',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setStoredRoomOwnerAgentTypeForTests('dc:stored-owner-fallback', 'codex');

    expect(getEffectiveChannelLease('dc:stored-owner-fallback')).toMatchObject({
      chat_jid: 'dc:stored-owner-fallback',
      owner_service_id: 'codex-main',
      reviewer_service_id: null,
      owner_failover_active: false,
      explicit: false,
    });
  });

  it('creates a same-service reviewer lease when explicit tribunal is runnable on a solo registration', () => {
    _setRegisteredGroupForTests('dc:explicit-tribunal', {
      name: 'Explicit Tribunal Claude',
      folder: 'explicit-tribunal-claude',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    setExplicitRoomMode('dc:explicit-tribunal', 'tribunal');

    expect(getEffectiveChannelLease('dc:explicit-tribunal')).toMatchObject({
      chat_jid: 'dc:explicit-tribunal',
      owner_service_id: 'claude',
      reviewer_service_id: 'claude',
      owner_failover_active: false,
      explicit: false,
    });
  });

  it('builds reviewer lease from stored tribunal mode even when legacy rows are incomplete', () => {
    _setRegisteredGroupForTests('dc:explicit-tribunal-codex', {
      name: 'Explicit Tribunal Codex',
      folder: 'explicit-tribunal-codex',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });
    setExplicitRoomMode('dc:explicit-tribunal-codex', 'tribunal');

    expect(
      getEffectiveChannelLease('dc:explicit-tribunal-codex'),
    ).toMatchObject({
      chat_jid: 'dc:explicit-tribunal-codex',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude',
      owner_failover_active: false,
      explicit: false,
    });
  });

  it('uses room-level reviewer and arbiter agent overrides from assign_room', () => {
    assignRoom('dc:room-role-overrides', {
      name: 'Room Role Overrides',
      roomMode: 'tribunal',
      ownerAgentType: 'claude-code',
      reviewerAgentType: 'codex',
      arbiterAgentType: 'claude-code',
      folder: 'room-role-overrides',
    });

    expect(getEffectiveChannelLease('dc:room-role-overrides')).toMatchObject({
      chat_jid: 'dc:room-role-overrides',
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
      arbiter_agent_type: 'claude-code',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-review',
      arbiter_service_id: 'claude',
      owner_failover_active: false,
      explicit: false,
    });
  });

  it('defaults to the configured owner service for chats without canonical room settings', () => {
    expect(getEffectiveChannelLease('dc:unregistered')).toMatchObject({
      chat_jid: 'dc:unregistered',
      owner_service_id: 'codex-main',
      reviewer_service_id: null,
      owner_failover_active: false,
      explicit: false,
    });
  });

  it('ignores legacy capability rows when canonical room settings are missing', () => {
    _setRegisteredGroupForTests('dc:legacy-only', {
      name: 'Legacy Only',
      folder: 'legacy-only',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    _setRegisteredGroupForTests('dc:legacy-only', {
      name: 'Legacy Only',
      folder: 'legacy-only',
      trigger: '@Codex',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'codex',
    });
    _deleteStoredRoomSettingsForTests('dc:legacy-only');

    expect(getEffectiveChannelLease('dc:legacy-only')).toMatchObject({
      chat_jid: 'dc:legacy-only',
      owner_service_id: 'codex-main',
      reviewer_service_id: null,
      owner_failover_active: false,
      explicit: false,
    });
  });
});

describe('resolveLeaseServiceId', () => {
  it('trusts the stored reviewer service id when a lease row already persisted it', () => {
    expect(
      resolveLeaseServiceId(
        {
          owner_agent_type: 'claude-code',
          reviewer_agent_type: 'codex',
          arbiter_agent_type: null,
          owner_service_id: 'claude',
          reviewer_service_id: 'stale-reviewer-shadow',
          arbiter_service_id: null,
          owner_failover_active: false,
        },
        'reviewer',
      ),
    ).toBe('stale-reviewer-shadow');
  });

  it('keeps the explicit owner failover service instead of recomputing the stable shadow', () => {
    expect(
      resolveLeaseServiceId(
        {
          owner_agent_type: 'claude-code',
          reviewer_agent_type: 'codex',
          arbiter_agent_type: null,
          owner_service_id: 'codex-review',
          reviewer_service_id: 'claude',
          arbiter_service_id: null,
          owner_failover_active: true,
        },
        'owner',
      ),
    ).toBe('codex-review');
  });
});

describe('stored lease ids as SSOT', () => {
  it('preserves a stored reviewer service id instead of recomputing it from role metadata', () => {
    setChannelOwnerLease({
      chat_jid: 'dc:stored-reviewer-ssot',
      owner_service_id: 'claude',
      reviewer_service_id: 'stale-reviewer-shadow',
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
      activated_at: '2026-04-09T00:00:00.000Z',
      reason: 'ssot-test',
    });
    refreshChannelOwnerCache(true);

    const lease = getEffectiveChannelLease('dc:stored-reviewer-ssot');
    expect(lease).toMatchObject({
      owner_service_id: 'claude',
      reviewer_service_id: 'stale-reviewer-shadow',
      owner_agent_type: 'claude-code',
      reviewer_agent_type: 'codex',
      explicit: true,
    });
    expect(resolveLeaseServiceId(lease, 'reviewer')).toBe(
      'stale-reviewer-shadow',
    );
  });
});
