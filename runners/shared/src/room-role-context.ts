export interface RoomRoleContext {
  serviceId: string;
  role: 'owner' | 'reviewer';
  ownerServiceId: string;
  reviewerServiceId: string;
  failoverOwner: boolean;
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
