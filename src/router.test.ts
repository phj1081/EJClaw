import { describe, expect, it } from 'vitest';

import {
  findChannelForDeliveryRole,
  resolveChannelForDeliveryRole,
} from './router.js';
import { type Channel } from './types.js';

function createChannel(name: string, ownedJids: string[]): Channel {
  return {
    name,
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => true,
    ownsJid: (jid) => ownedJids.includes(jid),
    disconnect: async () => {},
  };
}

describe('findChannelForDeliveryRole', () => {
  const jid = 'dc:123';

  it('prefers the reviewer channel for reviewer IPC messages', () => {
    const ownerChannel = createChannel('discord-main', [jid]);
    const reviewerChannel = createChannel('discord-review', [jid]);

    expect(
      findChannelForDeliveryRole(
        [ownerChannel, reviewerChannel],
        jid,
        'reviewer',
      ),
    ).toBe(reviewerChannel);
  });

  it('prefers the arbiter channel for arbiter IPC messages', () => {
    const ownerChannel = createChannel('discord-main', [jid]);
    const reviewerChannel = createChannel('discord-review', [jid]);
    const arbiterChannel = createChannel('discord-arbiter', [jid]);

    expect(
      findChannelForDeliveryRole(
        [ownerChannel, reviewerChannel, arbiterChannel],
        jid,
        'arbiter',
      ),
    ).toBe(arbiterChannel);
  });

  it('falls back to the first JID-owning channel when no role channel exists', () => {
    const ownerChannel = createChannel('discord-main', [jid]);

    expect(findChannelForDeliveryRole([ownerChannel], jid, 'reviewer')).toBe(
      ownerChannel,
    );
  });

  it('reports fallback metadata when a role-specific channel is unavailable', () => {
    const ownerChannel = createChannel('discord-main', [jid]);

    expect(
      resolveChannelForDeliveryRole([ownerChannel], jid, 'reviewer'),
    ).toEqual(
      expect.objectContaining({
        channel: ownerChannel,
        requestedRoleChannelName: 'discord-review',
        selectedChannelName: 'discord-main',
        usedRoleChannel: false,
        fallbackUsed: true,
      }),
    );
  });

  it('reports direct role routing metadata when the role channel exists', () => {
    const ownerChannel = createChannel('discord-main', [jid]);
    const reviewerChannel = createChannel('discord-review', [jid]);

    expect(
      resolveChannelForDeliveryRole(
        [ownerChannel, reviewerChannel],
        jid,
        'reviewer',
      ),
    ).toEqual(
      expect.objectContaining({
        channel: reviewerChannel,
        requestedRoleChannelName: 'discord-review',
        selectedChannelName: 'discord-review',
        usedRoleChannel: true,
        fallbackUsed: false,
      }),
    );
  });
});
