import { normalizeServiceId } from './config.js';
import { resolveLeaseServiceId } from './service-routing.js';
import type { PairedRoomRole, RoomRoleContext } from './types.js';
import type { EffectiveChannelLease } from './service-routing.js';

export function buildRoomRoleContext(
  lease: EffectiveChannelLease,
  serviceId: string,
  preferredRole?: PairedRoomRole,
): RoomRoleContext | undefined {
  const normalizedServiceId = normalizeServiceId(serviceId);
  const reviewerServiceId = resolveLeaseServiceId(lease, 'reviewer');

  if (!reviewerServiceId) {
    return undefined;
  }

  const ownerServiceId =
    resolveLeaseServiceId(lease, 'owner') ??
    normalizeServiceId(lease.owner_service_id);
  const arbiterServiceId = resolveLeaseServiceId(lease, 'arbiter') ?? undefined;

  const matches = {
    owner: ownerServiceId === normalizedServiceId,
    reviewer: reviewerServiceId === normalizedServiceId,
    arbiter: arbiterServiceId === normalizedServiceId,
  };

  const canHonorPreferredRole =
    preferredRole === 'owner' ||
    (preferredRole === 'reviewer' && reviewerServiceId !== null) ||
    (preferredRole === 'arbiter' && arbiterServiceId !== undefined);

  const role =
    preferredRole && canHonorPreferredRole
      ? preferredRole
      : matches.arbiter
        ? 'arbiter'
        : matches.owner
          ? 'owner'
          : matches.reviewer
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
    ...(lease.owner_agent_type
      ? { ownerAgentType: lease.owner_agent_type }
      : {}),
    ...(lease.reviewer_agent_type !== undefined
      ? { reviewerAgentType: lease.reviewer_agent_type }
      : {}),
    failoverOwner: Boolean(lease.owner_failover_active),
    arbiterServiceId,
    ...(lease.arbiter_agent_type !== undefined
      ? { arbiterAgentType: lease.arbiter_agent_type }
      : {}),
  };
}
