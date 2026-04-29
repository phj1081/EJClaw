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

type OptionalRoleMetadataInput = RequiredRoleMetadataInput;

function resolveFilledRequiredAgentType(
  input: RequiredRoleMetadataInput,
): AgentType {
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

function readStoredRequiredAgentType(
  input: RequiredRoleMetadataInput,
): AgentType {
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

  if (persistedAgentType) {
    return persistedAgentType;
  }

  throw new Error(
    `${input.context}: cannot read ${input.role}_agent_type from stored row metadata`,
  );
}

function resolveFilledRequiredServiceId(
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

function readStoredRequiredServiceId(
  context: string,
  role: PairedRoomRole,
  storedServiceId?: string | null,
): string {
  if (storedServiceId) {
    return storedServiceId;
  }

  throw new Error(
    `${context}: cannot read ${role}_service_id from stored row metadata`,
  );
}

function resolveFilledOptionalRoleMetadata(input: OptionalRoleMetadataInput): {
  agentType: AgentType | null;
  serviceId: string | null;
} {
  if (!input.storedAgentType && !input.storedServiceId) {
    return { agentType: null, serviceId: null };
  }

  const agentType = resolveFilledRequiredAgentType(input);
  return {
    agentType,
    serviceId: resolveFilledRequiredServiceId(
      input.context,
      input.role,
      agentType,
      input.storedServiceId,
    ),
  };
}

function readStoredOptionalRoleMetadata(input: OptionalRoleMetadataInput): {
  agentType: AgentType | null;
  serviceId: string | null;
} {
  if (!input.storedAgentType && !input.storedServiceId) {
    return { agentType: null, serviceId: null };
  }

  const agentType = readStoredRequiredAgentType(input);
  return {
    agentType,
    serviceId: readStoredRequiredServiceId(
      input.context,
      input.role,
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

export function fillCanonicalPairedTaskMetadata(input: {
  id: string;
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}): CanonicalPairedTaskMetadata {
  const context = `paired_tasks(${input.id})`;
  const ownerAgentType = resolveFilledRequiredAgentType({
    context,
    role: 'owner',
    storedAgentType: input.owner_agent_type,
    storedServiceId: input.owner_service_id,
    fallbackAgentType: OWNER_AGENT_TYPE,
  });
  const reviewerAgentType = resolveFilledRequiredAgentType({
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
    ownerServiceId: resolveFilledRequiredServiceId(
      context,
      'owner',
      ownerAgentType,
      input.owner_service_id,
    ),
    reviewerServiceId: resolveFilledRequiredServiceId(
      context,
      'reviewer',
      reviewerAgentType,
      input.reviewer_service_id,
    ),
  };
}

export function readCanonicalPairedTaskMetadata(input: {
  id: string;
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}): CanonicalPairedTaskMetadata {
  const context = `paired_tasks(${input.id})`;
  const ownerAgentType = readStoredRequiredAgentType({
    context,
    role: 'owner',
    storedAgentType: input.owner_agent_type,
    storedServiceId: input.owner_service_id,
  });
  const reviewerAgentType = readStoredRequiredAgentType({
    context,
    role: 'reviewer',
    storedAgentType: input.reviewer_agent_type,
    storedServiceId: input.reviewer_service_id,
  });

  return {
    ownerAgentType,
    reviewerAgentType,
    arbiterAgentType:
      normalizeStoredAgentType(input.arbiter_agent_type) ?? null,
    ownerServiceId: readStoredRequiredServiceId(
      context,
      'owner',
      input.owner_service_id,
    ),
    reviewerServiceId: readStoredRequiredServiceId(
      context,
      'reviewer',
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

export function fillCanonicalChannelOwnerLeaseMetadata(input: {
  chat_jid: string;
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  arbiter_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}): CanonicalChannelOwnerLeaseMetadata {
  const context = `channel_owner(${input.chat_jid})`;
  const ownerAgentType = resolveFilledRequiredAgentType({
    context,
    role: 'owner',
    storedAgentType: input.owner_agent_type,
    storedServiceId: input.owner_service_id,
  });
  const reviewer = resolveFilledOptionalRoleMetadata({
    context,
    role: 'reviewer',
    storedAgentType: input.reviewer_agent_type,
    storedServiceId: input.reviewer_service_id,
  });
  const arbiter = resolveFilledOptionalRoleMetadata({
    context,
    role: 'arbiter',
    storedAgentType: input.arbiter_agent_type,
    storedServiceId: input.arbiter_service_id,
  });

  return {
    ownerAgentType,
    reviewerAgentType: reviewer.agentType,
    arbiterAgentType: arbiter.agentType,
    ownerServiceId: resolveFilledRequiredServiceId(
      context,
      'owner',
      ownerAgentType,
      input.owner_service_id,
    ),
    reviewerServiceId: reviewer.serviceId,
    arbiterServiceId: arbiter.serviceId,
  };
}

export function readCanonicalChannelOwnerLeaseMetadata(input: {
  chat_jid: string;
  owner_service_id?: string | null;
  reviewer_service_id?: string | null;
  arbiter_service_id?: string | null;
  owner_agent_type?: string | null;
  reviewer_agent_type?: string | null;
  arbiter_agent_type?: string | null;
}): CanonicalChannelOwnerLeaseMetadata {
  const context = `channel_owner(${input.chat_jid})`;
  const ownerAgentType = readStoredRequiredAgentType({
    context,
    role: 'owner',
    storedAgentType: input.owner_agent_type,
    storedServiceId: input.owner_service_id,
  });
  const reviewer = readStoredOptionalRoleMetadata({
    context,
    role: 'reviewer',
    storedAgentType: input.reviewer_agent_type,
    storedServiceId: input.reviewer_service_id,
  });
  const arbiter = readStoredOptionalRoleMetadata({
    context,
    role: 'arbiter',
    storedAgentType: input.arbiter_agent_type,
    storedServiceId: input.arbiter_service_id,
  });

  return {
    ownerAgentType,
    reviewerAgentType: reviewer.agentType,
    arbiterAgentType: arbiter.agentType,
    ownerServiceId: readStoredRequiredServiceId(
      context,
      'owner',
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

export function fillCanonicalServiceHandoffMetadata(input: {
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

  const sourceAgentTypeForShadow =
    storedSourceAgentType ?? inferredSourceAgentType ?? null;
  const sourceServiceId =
    input.source_service_id ??
    (sourceRole != null && sourceAgentTypeForShadow != null
      ? resolveRoleServiceShadow(sourceRole, sourceAgentTypeForShadow)
      : null) ??
    SERVICE_SESSION_SCOPE;
  const sourceAgentType =
    storedSourceAgentType ??
    inferredSourceAgentType ??
    inferAgentTypeFromServiceShadow(sourceServiceId) ??
    null;

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

function readStoredHandoffAgentType(args: {
  context: string;
  field: 'source_agent_type' | 'target_agent_type';
  serviceField: 'source_service_id' | 'target_service_id';
  storedAgentType?: string | null;
  storedServiceId?: string | null;
}): AgentType {
  const persistedAgentType = normalizeStoredAgentType(args.storedAgentType);
  const inferredAgentType = inferAgentTypeFromServiceShadow(
    args.storedServiceId,
  );
  if (
    persistedAgentType &&
    inferredAgentType &&
    persistedAgentType !== inferredAgentType
  ) {
    throw new Error(
      `${args.context}: ${args.field} conflicts with ${args.serviceField}`,
    );
  }

  if (persistedAgentType) {
    return persistedAgentType;
  }

  throw new Error(
    `${args.context}: cannot read ${args.field} from stored row metadata`,
  );
}

function readStoredHandoffServiceId(args: {
  context: string;
  field: 'source_service_id' | 'target_service_id';
  storedServiceId?: string | null;
}): string {
  if (args.storedServiceId) {
    return args.storedServiceId;
  }

  throw new Error(
    `${args.context}: cannot read ${args.field} from stored row metadata`,
  );
}

export function readCanonicalServiceHandoffMetadata(input: {
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
  const sourceServiceId = readStoredHandoffServiceId({
    context,
    field: 'source_service_id',
    storedServiceId: input.source_service_id,
  });
  const targetServiceId = readStoredHandoffServiceId({
    context,
    field: 'target_service_id',
    storedServiceId: input.target_service_id,
  });
  const sourceAgentType = readStoredHandoffAgentType({
    context,
    field: 'source_agent_type',
    serviceField: 'source_service_id',
    storedAgentType: input.source_agent_type,
    storedServiceId: sourceServiceId,
  });
  const targetAgentType = readStoredHandoffAgentType({
    context,
    field: 'target_agent_type',
    serviceField: 'target_service_id',
    storedAgentType: input.target_agent_type,
    storedServiceId: targetServiceId,
  });

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
      const owner = resolveFilledOptionalRoleMetadata({
        context: `paired_task_execution_leases(${row.rowid})`,
        role: 'owner',
        storedAgentType: row.owner_agent_type,
        storedServiceId: row.owner_service_id,
      });
      return owner.serviceId;
    }
    case 'reviewer': {
      const reviewer = resolveFilledOptionalRoleMetadata({
        context: `paired_task_execution_leases(${row.rowid})`,
        role: 'reviewer',
        storedAgentType: row.reviewer_agent_type,
        storedServiceId: row.reviewer_service_id,
      });
      return reviewer.serviceId;
    }
    case 'arbiter': {
      const arbiter = resolveFilledOptionalRoleMetadata({
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
