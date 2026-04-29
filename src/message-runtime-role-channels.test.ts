import { describe, expect, it, vi } from 'vitest';

import { resolvePairedRoleChannels } from './message-runtime-role-channels.js';
import type { Channel } from './types.js';

function makeChannel(name: string): Channel {
  return {
    name,
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => false),
    disconnect: vi.fn(),
  } as unknown as Channel;
}

describe('message-runtime-role-channels', () => {
  it('maps owner, reviewer, and arbiter roles to their runtime channels', () => {
    const ownerChannel = makeChannel('discord-owner');
    const reviewerChannel = makeChannel('discord-review');
    const arbiterChannel = makeChannel('discord-arbiter');

    const result = resolvePairedRoleChannels(
      [ownerChannel, reviewerChannel, arbiterChannel],
      ownerChannel,
    );

    expect(result).toEqual({
      roleToChannel: {
        owner: ownerChannel,
        reviewer: reviewerChannel,
        arbiter: arbiterChannel,
      },
      reviewerChannelName: 'discord-review',
      foundReviewerChannel: reviewerChannel,
      arbiterChannelName: 'discord-arbiter',
      foundArbiterChannel: arbiterChannel,
    });
  });

  it('keeps missing reviewer and arbiter channels explicit as null', () => {
    const ownerChannel = makeChannel('discord-owner');

    expect(resolvePairedRoleChannels([ownerChannel], ownerChannel)).toEqual({
      roleToChannel: {
        owner: ownerChannel,
        reviewer: null,
        arbiter: null,
      },
      reviewerChannelName: 'discord-review',
      foundReviewerChannel: null,
      arbiterChannelName: 'discord-arbiter',
      foundArbiterChannel: null,
    });
  });
});
