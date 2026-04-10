import type { RunnerAgentType } from './reviewer-runtime-policy.js';

export interface RoomRoleContext {
  serviceId: string;
  role: 'owner' | 'reviewer' | 'arbiter';
  ownerServiceId: string;
  reviewerServiceId: string;
  ownerAgentType?: RunnerAgentType;
  reviewerAgentType?: RunnerAgentType | null;
  failoverOwner: boolean;
  arbiterServiceId?: string;
  arbiterAgentType?: RunnerAgentType | null;
}

export function prependRoomRoleHeader(
  prompt: string,
  roomRoleContext?: RoomRoleContext,
): string {
  if (!roomRoleContext) {
    return prompt;
  }

  const header =
    `[ROOM_ROLE self=${roomRoleContext.serviceId} role=${roomRoleContext.role} ` +
    `owner=${roomRoleContext.ownerServiceId} reviewer=${roomRoleContext.reviewerServiceId} ` +
    `failover=${roomRoleContext.failoverOwner ? 1 : 0}]`;

  return `${header}\n\n${prompt}`;
}
