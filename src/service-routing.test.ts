import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  setExplicitRoomMode,
  setRegisteredGroup,
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
    setRegisteredGroup('dc:paired', {
      name: 'Paired Room Claude',
      folder: 'paired-claude',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:paired', {
      name: 'Paired Room Codex',
      folder: 'paired-codex',
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
    setRegisteredGroup('dc:paired', {
      name: 'Paired Room Claude',
      folder: 'paired-claude',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:paired', {
      name: 'Paired Room Codex',
      folder: 'paired-codex',
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
    setRegisteredGroup('dc:explicit-single', {
      name: 'Explicit Single Claude',
      folder: 'explicit-single-claude',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentType: 'claude-code',
    });
    setRegisteredGroup('dc:explicit-single', {
      name: 'Explicit Single Codex',
      folder: 'explicit-single-codex',
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

  it('does not create reviewer lease for explicit tribunal without dual registration capability', () => {
    setRegisteredGroup('dc:explicit-tribunal', {
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
      reviewer_service_id: null,
      explicit: false,
    });
  });
});
