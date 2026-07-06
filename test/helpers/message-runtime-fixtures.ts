import { vi } from 'vitest';

import type { EffectiveChannelLease } from '../../src/service-routing.js';
import { TASK_STATUS_MESSAGE_PREFIX } from '../../src/task-watch-status.js';
import type { Channel, RegisteredGroup } from '../../src/types.js';

/** Prefix helper for progress message assertions */
export const P = (text: string) => `${TASK_STATUS_MESSAGE_PREFIX}${text}`;

export const makeCodexLease = (chatJid: string): EffectiveChannelLease => ({
  chat_jid: chatJid,
  owner_agent_type: 'codex',
  reviewer_agent_type: null,
  arbiter_agent_type: null,
  owner_service_id: 'codex',
  reviewer_service_id: null,
  arbiter_service_id: null,
  owner_failover_active: false,
  activated_at: null,
  reason: null,
  explicit: false,
});

export function makeGroup(agentType: 'claude-code' | 'codex'): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: `test-${agentType}`,
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    agentType,
  };
}

export function makeChannel(
  chatJid: string,
  name = 'discord',
  ownsJid = true,
): Channel {
  return {
    name,
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAndTrack: vi.fn().mockResolvedValue('progress-1'),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => ownsJid && jid === chatJid),
    disconnect: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
  };
}
