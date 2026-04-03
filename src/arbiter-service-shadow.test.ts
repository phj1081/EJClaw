import { beforeEach, describe, expect, it } from 'vitest';

import {
  ARBITER_AGENT_TYPE,
  ARBITER_SERVICE_ID,
  CLAUDE_SERVICE_ID,
  CODEX_MAIN_SERVICE_ID,
} from './config.js';
import {
  _initTestDatabase,
  createServiceHandoff,
  getChannelOwnerLease,
  setChannelOwnerLease,
} from './db.js';
import { resolveRoleServiceShadow } from './role-service-shadow.js';
import {
  clearGlobalFailover,
  getEffectiveChannelLease,
  refreshChannelOwnerCache,
} from './service-routing.js';

const customArbiterEnabled =
  ARBITER_AGENT_TYPE === 'codex' && ARBITER_SERVICE_ID != null;

describe.skipIf(!customArbiterEnabled)('custom arbiter service shadow', () => {
  beforeEach(() => {
    _initTestDatabase();
    clearGlobalFailover();
    refreshChannelOwnerCache(true);
  });

  it('maps codex arbiter shadow to the configured arbiter service id', () => {
    expect(resolveRoleServiceShadow('arbiter', 'codex')).toBe(
      ARBITER_SERVICE_ID,
    );
  });

  it('preserves the configured arbiter service id in explicit channel leases', () => {
    setChannelOwnerLease({
      chat_jid: 'dc:custom-arbiter-lease',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: 'codex',
    });
    refreshChannelOwnerCache(true);

    expect(getChannelOwnerLease('dc:custom-arbiter-lease')).toMatchObject({
      owner_service_id: CODEX_MAIN_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
      arbiter_service_id: ARBITER_SERVICE_ID,
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: 'codex',
    });
    expect(getEffectiveChannelLease('dc:custom-arbiter-lease')).toMatchObject({
      owner_service_id: CODEX_MAIN_SERVICE_ID,
      reviewer_service_id: CLAUDE_SERVICE_ID,
      arbiter_service_id: ARBITER_SERVICE_ID,
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      arbiter_agent_type: 'codex',
    });
  });

  it('uses the configured arbiter service id for derived arbiter handoffs', () => {
    const handoff = createServiceHandoff({
      chat_jid: 'dc:custom-arbiter-handoff',
      group_folder: 'custom-arbiter-handoff',
      source_role: 'owner',
      source_agent_type: 'codex',
      target_role: 'arbiter',
      target_agent_type: 'codex',
      prompt: 'arbiter please decide',
      intended_role: 'arbiter',
    });

    expect(handoff).toMatchObject({
      source_service_id: CODEX_MAIN_SERVICE_ID,
      target_service_id: ARBITER_SERVICE_ID,
      source_role: 'owner',
      target_role: 'arbiter',
      target_agent_type: 'codex',
    });
  });
});
