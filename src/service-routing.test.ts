import { beforeEach, describe, expect, it } from 'vitest';

import {
  _setRegisteredGroupForTests,
  _setStoredRoomOwnerAgentTypeForTests,
  _initTestDatabase,
  setExplicitRoomMode,
} from './db.js';
import {
  activateCodexFailover,
  clearGlobalFailover,
  getEffectiveChannelLease,
  getGlobalFailoverInfo,
  refreshChannelOwnerCache,
} from './service-routing.js';

beforeEach(() => {
  _initTestDatabase();
  refreshChannelOwnerCache(true);
  clearGlobalFailover();
});

describe('service-routing global failover', () => {
  it('uses codex-review as owner during global failover', () => {
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
      reviewer_service_id: 'codex-main',
      reason: 'claude-429',
      explicit: true,
    });
    // Any other channel is also affected
    expect(getEffectiveChannelLease('dc:other')).toMatchObject({
      owner_service_id: 'codex-review',
      reviewer_service_id: 'codex-main',
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
      explicit: false,
    });
  });

  it('falls back to the available service when stored owner agent type is unavailable', () => {
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
      owner_service_id: 'claude',
      reviewer_service_id: null,
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
      explicit: false,
    });
  });

  it('keeps reviewer lease disabled when explicit tribunal cannot deliver the configured reviewer', () => {
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
      reviewer_service_id: null,
      explicit: false,
    });
  });

  it('keeps the legacy claude fallback for chats without room settings', () => {
    expect(getEffectiveChannelLease('dc:unregistered')).toMatchObject({
      chat_jid: 'dc:unregistered',
      owner_service_id: 'claude',
      reviewer_service_id: null,
      explicit: false,
    });
  });
});
