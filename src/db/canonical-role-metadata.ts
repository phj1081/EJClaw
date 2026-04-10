import {
  ARBITER_AGENT_TYPE,
  OWNER_AGENT_TYPE,
  REVIEWER_AGENT_TYPE,
  SERVICE_SESSION_SCOPE,
} from '../config.js';
import {
  inferAgentTypeFromServiceShadow,
  inferRoleFromServiceShadow,
  resolveRoleServiceShadow,
} from '../role-service-shadow.js';
import type { AgentType, PairedRoomRole } from '../types.js';
import { normalizeStoredAgentType } from './room-registration.js';

interface RequiredRoleMetadataInput {
  context: string;
  role: PairedRoomRole;
  storedAgentType?: string | null;
  storedServiceId?: string | null;
  fallbackAgentType?: AgentType | null;
}

interface OptionalRoleMetadataInput extends RequiredRoleMetadataInput {}

function resolveRequiredAgentType(input: RequiredRoleMetadataInput): AgentType {
  const persistedAgentType = normalizeStoredAgentType(input.storedAgentType);
  const inferredAgentType = inferAgentTypeFromServiceShadow(
    input.storedServiceId,
  );
  if (
    persistedAgentType &&
    inferredAgentType &&
    persistedAgentType !== inferredAgentType
  ) {
    throw new Error(
      `${input.context}: ${input.role}_agent_type conflicts with ${input.role}_service_id`,
    );
  }

  const agentType =
    persistedAgentType ?? inferredAgentType ?? input.fallbackAgentType ?? null;
  if (agentType) {
    return agentType;
  }

  throw new Error(
    `${input.context}: cannot resolve ${input.role}_agent_type from stored row metadata`,
  );
}

function resolveRequiredServiceId(
  context: string,
  role: PairedRoomRole,
  agentType: AgentType,
  storedServiceId?: string | null,
): string {
  return (
    storedServiceId ??
    resolveRoleServiceShadow(role, agentType) ??
    (() => {
      throw new Error(
        `${context}: cannot resolve ${role}_service_id from stored row metadata`,
      );
    })()
  );
}

function resolveOptionalRoleMetadata(input: OptionalRoleMetadataInput): {
  agentType: AgentType | null;
  serviceId: string | null;
} {
  if (!input.storedAgentType && !input.storedServiceId) {
    return { agentType: null, serviceId: null };
  }

  const agentType = resolveRequiredAgentType(input);
  return {
    agentType,
    serviceId: resolveRequiredServiceId(
      input.context,
      input.role,
      agentType,
      input.storedServiceId,
    ),
  };
}

export interface CanonicalPairedTaskMetadata {
  ownerAgentType: AgentType;
  reviewerAgentType: AgentType;
  arbiterAgentType: AgentType | null;
  ownerServiceId: string;
  reviewerServiceId: string;
}

export function canonicalizePairedTaskMetadata(input: {
  id: string;
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}): CanonicalPairedTaskMetadata {
  const context = `paired_tasks(${input.id})`;
  const ownerAgentType = resolveRequiredAgentType({
    context,
    role: 'owner',
    storedAgentType: input.owner_agent_type,
    storedServiceId: input.owner_service_id,
    fallbackAgentType: OWNER_AGENT_TYPE,
  });
  const reviewerAgentType = resolveRequiredAgentType({
    context,
    role: 'reviewer',
    storedAgentType: input.reviewer_agent_type,
    storedServiceId: input.reviewer_service_id,
    fallbackAgentType: REVIEWER_AGENT_TYPE,
  });

  return {
    ownerAgentType,
    reviewerAgentType,
    arbiterAgentType:
      normalizeStoredAgentType(input.arbiter_agent_type) ??
      ARBITER_AGENT_TYPE ??
      null,
    ownerServiceId: resolveRequiredServiceId(
      context,
      'owner',
      ownerAgentType,
      input.owner_service_id,
    ),
    reviewerServiceId: resolveRequiredServiceId(
      context,
      'reviewer',
      reviewerAgentType,
      input.reviewer_service_id,
    ),
  };
}

export interface CanonicalChannelOwnerLeaseMetadata {
  ownerAgentType: AgentType;
  reviewerAgentType: AgentType | null;
  arbiterAgentType: AgentType | null;
  ownerServiceId: string;
  reviewerServiceId: string | null;
  arbiterServiceId: string | null;
}

export function canonicalizeChannelOwnerLeaseMetadata(input: {
  chat_jid: string;
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  arbiter_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}): CanonicalChannelOwnerLeaseMetadata {
  const context = `channel_owner(${input.chat_jid})`;
  const ownerAgentType = resolveRequiredAgentType({
    context,
    role: 'owner',
    storedAgentType: input.owner_agent_type,
    storedServiceId: input.owner_service_id,
  });
  const reviewer = resolveOptionalRoleMetadata({
    context,
    role: 'reviewer',
    storedAgentType: input.reviewer_agent_type,
    storedServiceId: input.reviewer_service_id,
  });
  const arbiter = resolveOptionalRoleMetadata({
    context,
    role: 'arbiter',
    storedAgentType: input.arbiter_agent_type,
    storedServiceId: input.arbiter_service_id,
  });

  return {
    ownerAgentType,
    reviewerAgentType: reviewer.agentType,
    arbiterAgentType: arbiter.agentType,
    ownerServiceId: resolveRequiredServiceId(
      context,
      'owner',
      ownerAgentType,
      input.owner_service_id,
    ),
    reviewerServiceId: reviewer.serviceId,
    arbiterServiceId: arbiter.serviceId,
  };
}

function normalizeHandoffRole(
  role: string | null | undefined,
): PairedRoomRole | null {
  return role === 'owner' || role === 'reviewer' || role === 'arbiter'
    ? role
    : null;
}

function assertStoredRoleMatchesServiceShadow(args: {
  context: string;
  storedRole: PairedRoomRole | null;
  agentType: AgentType | null;
  serviceId: string | null;
  roleField: 'source_role' | 'target_role';
  serviceField: 'source_service_id' | 'target_service_id';
}): void {
  if (!args.storedRole || !args.agentType || !args.serviceId) {
    return;
  }

  const inferredRole = inferRoleFromServiceShadow(
    args.agentType,
    args.serviceId,
  );
  if (inferredRole && inferredRole !== args.storedRole) {
    throw new Error(
      `${args.context}: ${args.roleField} conflicts with ${args.serviceField}`,
    );
  }
}

export interface CanonicalServiceHandoffMetadata {
  sourceRole: PairedRoomRole | null;
  targetRole: PairedRoomRole | null;
  sourceAgentType: AgentType | null;
  targetAgentType: AgentType;
  sourceServiceId: string;
  targetServiceId: string;
}

export function canonicalizeServiceHandoffMetadata(input: {
  id: number | string;
  chat_jid: string;
  source_service_id?: string | null;
  target_service_id?: string | null;
  source_role?: string | null;
  target_role?: string | null;
  intended_role?: string | null;
  source_agent_type?: string | null;
  target_agent_type?: string | null;
}): CanonicalServiceHandoffMetadata {
  const context = `service_handoffs(${input.id})`;
  const sourceRole =
    normalizeHandoffRole(input.source_role) ??
    normalizeHandoffRole(input.intended_role);
  const targetRole =
    normalizeHandoffRole(input.target_role) ??
    normalizeHandoffRole(input.intended_role);
  const storedSourceAgentType = normalizeStoredAgentType(
    input.source_agent_type,
  );
  const inferredSourceAgentType = inferAgentTypeFromServiceShadow(
    input.source_service_id,
  );
  if (
    storedSourceAgentType &&
    inferredSourceAgentType &&
    storedSourceAgentType !== inferredSourceAgentType
  ) {
    throw new Error(
      `${context}: source_agent_type conflicts with source_service_id`,
    );
  }
  const sourceAgentType =
    storedSourceAgentType ?? inferredSourceAgentType ?? null;
  const storedTargetAgentType = normalizeStoredAgentType(
    input.target_agent_type,
  );
  const inferredTargetAgentType = inferAgentTypeFromServiceShadow(
    input.target_service_id,
  );
  if (
    storedTargetAgentType &&
    inferredTargetAgentType &&
    storedTargetAgentType !== inferredTargetAgentType
  ) {
    throw new Error(
      `${context}: target_agent_type conflicts with target_service_id`,
    );
  }
  const targetAgentType = storedTargetAgentType ?? inferredTargetAgentType;

  if (!targetAgentType) {
    throw new Error(
      `${context}: cannot resolve target_agent_type from stored row metadata`,
    );
  }

  const targetServiceId =
    input.target_service_id ??
    (targetRole != null
      ? resolveRoleServiceShadow(targetRole, targetAgentType)
      : null);
  if (!targetServiceId) {
    throw new Error(
      `${context}: cannot resolve target_service_id from stored row metadata`,
    );
  }

  const sourceServiceId =
    input.source_service_id ??
    (sourceRole != null && sourceAgentType != null
      ? resolveRoleServiceShadow(sourceRole, sourceAgentType)
      : null) ??
    SERVICE_SESSION_SCOPE;

  assertStoredRoleMatchesServiceShadow({
    context,
    storedRole: sourceRole,
    agentType: sourceAgentType,
    serviceId: sourceServiceId,
    roleField: 'source_role',
    serviceField: 'source_service_id',
  });
  assertStoredRoleMatchesServiceShadow({
    context,
    storedRole: targetRole,
    agentType: targetAgentType,
    serviceId: targetServiceId,
    roleField: 'target_role',
    serviceField: 'target_service_id',
  });

  return {
    sourceRole,
    targetRole,
    sourceAgentType,
    targetAgentType,
    sourceServiceId,
    targetServiceId,
  };
}

interface ExecutionLeaseMetadataRow {
  rowid: number;
  role: string;
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  arbiter_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}

export function inferExecutionLeaseServiceIdFromCanonicalMetadata(
  row: ExecutionLeaseMetadataRow,
): string | null {
  switch (row.role) {
    case 'owner': {
      const owner = resolveOptionalRoleMetadata({
        context: `paired_task_execution_leases(${row.rowid})`,
        role: 'owner',
        storedAgentType: row.owner_agent_type,
        storedServiceId: row.owner_service_id,
      });
      return owner.serviceId;
    }
    case 'reviewer': {
      const reviewer = resolveOptionalRoleMetadata({
        context: `paired_task_execution_leases(${row.rowid})`,
        role: 'reviewer',
        storedAgentType: row.reviewer_agent_type,
        storedServiceId: row.reviewer_service_id,
      });
      return reviewer.serviceId;
    }
    case 'arbiter': {
      const arbiter = resolveOptionalRoleMetadata({
        context: `paired_task_execution_leases(${row.rowid})`,
        role: 'arbiter',
        storedAgentType: row.arbiter_agent_type,
        storedServiceId: row.arbiter_service_id,
      });
      return arbiter.serviceId;
    }
    default:
      return null;
  }
}
