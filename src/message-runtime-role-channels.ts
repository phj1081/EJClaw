import { findChannelByName } from './router.js';
import type { Channel, PairedRoomRole } from './types.js';

export type PairedRoleChannels = Record<PairedRoomRole, Channel | null>;

export interface PairedRoleChannelResolution {
  roleToChannel: PairedRoleChannels;
  reviewerChannelName: string;
  foundReviewerChannel: Channel | null;
  arbiterChannelName: string;
  foundArbiterChannel: Channel | null;
}

export function resolvePairedRoleChannels(
  channels: Channel[],
  ownerChannel: Channel,
): PairedRoleChannelResolution {
  const reviewerChannelName = 'discord-review';
  const foundReviewerChannel =
    findChannelByName(channels, reviewerChannelName) ?? null;

  const arbiterChannelName = 'discord-arbiter';
  const foundArbiterChannel =
    findChannelByName(channels, arbiterChannelName) ?? null;

  return {
    roleToChannel: {
      owner: ownerChannel,
      reviewer: foundReviewerChannel,
      arbiter: foundArbiterChannel,
    },
    reviewerChannelName,
    foundReviewerChannel,
    arbiterChannelName,
    foundArbiterChannel,
  };
}
