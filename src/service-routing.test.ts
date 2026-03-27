import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import {
  activateCodexFailover,
  getActiveCodexFailoverLeases,
  getEffectiveChannelLease,
  refreshChannelOwnerCache,
  restoreDefaultChannelLease,
} from './service-routing.js';

beforeEach(() => {
  _initTestDatabase();
  refreshChannelOwnerCache(true);
});

describe('service-routing failover leases', () => {
  it('uses codex-review as owner and codex-main as reviewer during failover', () => {
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

    expect(getEffectiveChannelLease('dc:paired')).toMatchObject({
      chat_jid: 'dc:paired',
      owner_service_id: 'codex-review',
      reviewer_service_id: 'codex-main',
      reason: 'claude-429',
      explicit: true,
    });
    expect(getActiveCodexFailoverLeases()).toEqual([
      {
        chatJid: 'dc:paired',
        activatedAt: expect.any(String),
      },
    ]);
  });

  it('restores the default lease after failover is cleared', () => {
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
    restoreDefaultChannelLease('dc:paired');

    expect(getEffectiveChannelLease('dc:paired')).toMatchObject({
      chat_jid: 'dc:paired',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      explicit: false,
    });
  });
});
