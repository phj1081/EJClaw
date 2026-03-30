import {
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  normalizeServiceId,
} from './config.js';
import type { RoomRoleContext } from './types.js';
import type { EffectiveChannelLease } from './service-routing.js';

export function buildRoomRoleContext(
  lease: EffectiveChannelLease,
  serviceId: string,
): RoomRoleContext | undefined {
  const normalizedServiceId = normalizeServiceId(serviceId);
  const reviewerServiceId = lease.reviewer_service_id
    ? normalizeServiceId(lease.reviewer_service_id)
    : null;

  if (!reviewerServiceId) {
    return undefined;
  }

  const ownerServiceId = normalizeServiceId(lease.owner_service_id);
  const arbiterServiceId = lease.arbiter_service_id
    ? normalizeServiceId(lease.arbiter_service_id)
    : undefined;

  // Check arbiter role first: if this service matches the arbiter_service_id,
  // it takes the arbiter role (even if it also matches owner or reviewer)
  const role =
    arbiterServiceId && arbiterServiceId === normalizedServiceId
      ? 'arbiter'
      : ownerServiceId === normalizedServiceId
        ? 'owner'
        : reviewerServiceId === normalizedServiceId
          ? 'reviewer'
          : null;

  if (!role) {
    return undefined;
  }

  return {
    serviceId: normalizedServiceId,
    role,
    ownerServiceId,
    reviewerServiceId,
    failoverOwner:
      ownerServiceId === CODEX_REVIEW_SERVICE_ID &&
      reviewerServiceId === CODEX_MAIN_SERVICE_ID,
    arbiterServiceId,
  };
}
