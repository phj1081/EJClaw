import { getLastHumanMessageTimestamp } from './db.js';
import { filterProcessableMessages } from './bot-message-filter.js';
import { normalizeStoredSeqCursor } from './message-cursor.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import { isTaskStatusControlMessage } from './task-watch-status.js';
import { ARBITER_AGENT_TYPE, REVIEWER_AGENT_TYPE } from './config.js';
import {
  hasReviewerLease,
  resolveLeaseServiceId,
  type EffectiveChannelLease,
} from './service-routing.js';
import {
  resolveAgentTypeForRole,
  resolveRoleAgentPlan,
  type RoleAgentPlan,
} from './role-agent-plan.js';
import {
  type AgentType,
  type Channel,
  type NewMessage,
  type PairedRoomRole,
  type PairedTaskStatus,
  type RegisteredGroup,
} from './types.js';

const BOT_COLLABORATION_WINDOW_MS = 12 * 60 * 60 * 1000;

export function advanceLastAgentCursor(
  lastAgentTimestamps: Record<string, string>,
  saveState: () => void,
  chatJid: string,
  cursorOrTimestamp: string | number,
  /** Override cursor key (e.g. `${chatJid}:reviewer` for paired rooms). */
  cursorKey?: string,
): void {
  const key = cursorKey ?? chatJid;
  if (typeof cursorOrTimestamp === 'number') {
    lastAgentTimestamps[key] = String(cursorOrTimestamp);
  } else {
    lastAgentTimestamps[key] = normalizeStoredSeqCursor(
      cursorOrTimestamp,
      chatJid,
    );
  }
  saveState();
}

/** Map task status to the active role. */
export function resolveActiveRole(
  taskStatus?: string | null,
): 'owner' | 'reviewer' | 'arbiter' {
  switch (taskStatus) {
    case 'review_ready':
    case 'in_review':
      return 'reviewer';
    case 'arbiter_requested':
    case 'in_arbitration':
      return 'arbiter';
    default:
      return 'owner';
  }
}

export function resolveQueuedTurnRole(args: {
  taskStatus?: PairedTaskStatus | null;
  hasHumanMessage: boolean;
}): 'owner' | 'reviewer' | 'arbiter' {
  if (
    args.hasHumanMessage &&
    (args.taskStatus === 'review_ready' || args.taskStatus === 'in_review')
  ) {
    return 'owner';
  }

  return resolveActiveRole(args.taskStatus);
}

export type NextTurnAction =
  | { kind: 'none' }
  | { kind: 'reviewer-turn' }
  | { kind: 'arbiter-turn' }
  | { kind: 'owner-follow-up' }
  | { kind: 'finalize-owner-turn' };

export type ScheduledNextTurnActionKind = Exclude<NextTurnAction['kind'], 'none'>;

export type FollowUpDispatch =
  | { kind: 'none' }
  | { kind: 'inline' }
  | { kind: 'enqueue'; queueKind: 'paired-follow-up' | 'message-check' };

export function resolveNextTurnAction(args: {
  taskStatus?: PairedTaskStatus | null;
  lastTurnOutputRole?: PairedRoomRole | null;
}): NextTurnAction {
  switch (args.taskStatus) {
    case 'review_ready':
    case 'in_review':
      return args.lastTurnOutputRole === 'reviewer'
        ? { kind: 'none' }
        : { kind: 'reviewer-turn' };
    case 'arbiter_requested':
    case 'in_arbitration':
      return args.lastTurnOutputRole === 'arbiter'
        ? { kind: 'none' }
        : { kind: 'arbiter-turn' };
    case 'merge_ready':
      return args.lastTurnOutputRole === 'owner'
        ? { kind: 'none' }
        : { kind: 'finalize-owner-turn' };
    case 'active':
      return args.lastTurnOutputRole === 'reviewer' ||
        args.lastTurnOutputRole === 'arbiter'
        ? { kind: 'owner-follow-up' }
        : { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

export function matchesExpectedPairedFollowUpIntent(args: {
  taskStatus?: PairedTaskStatus | null;
  lastTurnOutputRole?: PairedRoomRole | null;
  intentKind: ScheduledNextTurnActionKind;
}): boolean {
  return (
    resolveNextTurnAction({
      taskStatus: args.taskStatus,
      lastTurnOutputRole: args.lastTurnOutputRole,
    }).kind === args.intentKind
  );
}

export function resolveFollowUpDispatch(args: {
  source:
    | 'delivery-success'
    | 'owner-delivery-success'
    | 'delivery-retry'
    | 'bot-only-follow-up'
    | 'executor-recovery';
  nextTurnAction: NextTurnAction;
  completedRole?: PairedRoomRole;
  executionStatus?: 'succeeded' | 'failed';
  sawOutput?: boolean;
}): FollowUpDispatch {
  switch (args.source) {
    case 'delivery-success':
    case 'owner-delivery-success':
      if (
        args.source === 'owner-delivery-success' ||
        args.completedRole === 'owner'
      ) {
        return args.nextTurnAction.kind === 'reviewer-turn'
          ? { kind: 'enqueue', queueKind: 'paired-follow-up' }
          : { kind: 'none' };
      }
      return args.nextTurnAction.kind === 'none'
        ? { kind: 'none' }
        : { kind: 'enqueue', queueKind: 'paired-follow-up' };

    case 'delivery-retry':
      if (args.nextTurnAction.kind === 'none') {
        return { kind: 'enqueue', queueKind: 'message-check' };
      }
      return { kind: 'enqueue', queueKind: 'paired-follow-up' };

    case 'bot-only-follow-up':
      if (args.nextTurnAction.kind === 'none') {
        return { kind: 'none' };
      }
      if (args.nextTurnAction.kind === 'finalize-owner-turn') {
        return { kind: 'inline' };
      }
      return { kind: 'enqueue', queueKind: 'paired-follow-up' };

    case 'executor-recovery':
      if (args.executionStatus === 'succeeded' && args.sawOutput) {
        return { kind: 'none' };
      }
      if (
        args.completedRole !== 'reviewer' &&
        args.completedRole !== 'arbiter'
      ) {
        return { kind: 'none' };
      }
      return args.nextTurnAction.kind === 'reviewer-turn' ||
        args.nextTurnAction.kind === 'arbiter-turn' ||
        args.nextTurnAction.kind === 'finalize-owner-turn'
        ? { kind: 'enqueue', queueKind: 'paired-follow-up' }
        : { kind: 'none' };
  }
}

/** Cursor key for a role. Owner uses chatJid, others use chatJid:role. */
export function resolveCursorKey(
  chatJid: string,
  taskStatus?: string | null,
): string {
  if (!hasReviewerLease(chatJid)) return chatJid;
  const role = resolveActiveRole(taskStatus);
  return resolveCursorKeyForRole(chatJid, role);
}

export function resolveCursorKeyForRole(
  chatJid: string,
  role: 'owner' | 'reviewer' | 'arbiter',
): string {
  if (!hasReviewerLease(chatJid) || role === 'owner') return chatJid;
  return `${chatJid}:${role}`;
}

/** Resolve the effective agent type for a role, considering per-role overrides. */
export function resolveConfiguredRoleAgentPlan(
  paired: boolean,
  groupAgentType: AgentType | undefined,
): RoleAgentPlan {
  return resolveRoleAgentPlan({
    paired,
    groupAgentType,
    configuredReviewer: REVIEWER_AGENT_TYPE,
    configuredArbiter: ARBITER_AGENT_TYPE,
  });
}

/** Resolve the effective agent type for a role, considering per-role overrides. */
export function resolveEffectiveAgentType(
  role: 'owner' | 'reviewer' | 'arbiter',
  groupAgentType: AgentType | undefined,
): AgentType {
  const plan = resolveConfiguredRoleAgentPlan(role !== 'owner', groupAgentType);
  return resolveAgentTypeForRole(plan, role);
}

/** Session folder key for a role. Owner uses groupFolder, others use groupFolder:role. */
export function resolveSessionFolder(
  groupFolder: string,
  role: 'owner' | 'reviewer' | 'arbiter',
  groupAgentType: AgentType | undefined,
): string {
  // Arbiter always gets a separate session — must never share with owner/reviewer
  if (role === 'arbiter') return `${groupFolder}:arbiter`;
  const plan = resolveConfiguredRoleAgentPlan(role !== 'owner', groupAgentType);
  const effectiveType = resolveAgentTypeForRole(plan, role);
  const groupDefault = plan.ownerAgentType;
  if (effectiveType === groupDefault) return groupFolder;
  return `${groupFolder}:${role}`;
}

export interface ExecutionTargetResolution {
  inferredRole: PairedRoomRole;
  canHonorForcedRole: boolean;
  activeRole: PairedRoomRole;
  effectiveServiceId: string;
  reviewerServiceId: string | null;
  arbiterServiceId: string | null;
  roleAgentPlan: RoleAgentPlan;
  configuredAgentType: AgentType;
  effectiveAgentType: AgentType;
  sessionFolder: string;
}

export function resolveExecutionTarget(args: {
  lease: EffectiveChannelLease;
  pairedTaskStatus?: PairedTaskStatus | null;
  groupFolder: string;
  groupAgentType?: AgentType;
  forcedRole?: PairedRoomRole;
  forcedAgentType?: AgentType;
}): ExecutionTargetResolution {
  const inferredRole = resolveActiveRole(args.pairedTaskStatus);
  const canHonorForcedRole = Boolean(
    args.forcedRole === 'owner' ||
    (args.forcedRole === 'reviewer' && args.lease.reviewer_agent_type) ||
    (args.forcedRole === 'arbiter' && args.lease.arbiter_agent_type),
  );
  const activeRole = canHonorForcedRole ? args.forcedRole! : inferredRole;
  const effectiveServiceId = resolveLeaseServiceId(args.lease, activeRole);
  if (!effectiveServiceId) {
    throw new Error(`Missing runtime service id for ${activeRole} lease`);
  }

  const reviewerServiceId = resolveLeaseServiceId(args.lease, 'reviewer');
  const arbiterServiceId = resolveLeaseServiceId(args.lease, 'arbiter');
  const roleAgentPlan = resolveConfiguredRoleAgentPlan(
    args.lease.reviewer_agent_type != null,
    args.groupAgentType,
  );
  const configuredAgentType = resolveEffectiveAgentType(
    activeRole,
    args.groupAgentType,
  );
  const effectiveAgentType = args.forcedAgentType ?? configuredAgentType;

  return {
    inferredRole,
    canHonorForcedRole,
    activeRole,
    effectiveServiceId,
    reviewerServiceId,
    arbiterServiceId,
    roleAgentPlan,
    configuredAgentType,
    effectiveAgentType,
    sessionFolder: resolveSessionFolder(
      args.groupFolder,
      activeRole,
      args.groupAgentType,
    ),
  };
}

export function createImplicitContinuationTracker(idleTimeout: number) {
  const implicitContinuationUntil = new Map<string, number>();

  return {
    open(chatJid: string): void {
      if (idleTimeout <= 0) return;
      implicitContinuationUntil.set(chatJid, Date.now() + idleTimeout);
    },

    has(chatJid: string, messages: NewMessage[]): boolean {
      const until = implicitContinuationUntil.get(chatJid);
      if (!until) return false;
      if (Date.now() > until) {
        implicitContinuationUntil.delete(chatJid);
        return false;
      }
      return messages.some(
        (message) => message.is_from_me !== true && !message.is_bot_message,
      );
    },
  };
}

export function shouldSkipBotOnlyCollaboration(
  chatJid: string,
  messages: NewMessage[],
): boolean {
  if (hasReviewerLease(chatJid)) return false;
  const allFromBots = messages.every(
    (message) => message.is_from_me || !!message.is_bot_message,
  );
  if (!allFromBots) return false;
  const lastHuman = getLastHumanMessageTimestamp(chatJid);
  if (!lastHuman) return true;
  return (
    Date.now() - new Date(lastHuman).getTime() > BOT_COLLABORATION_WINDOW_MS
  );
}

export function hasAllowedTrigger(opts: {
  chatJid: string;
  messages: NewMessage[];
  group: RegisteredGroup;
  triggerPattern: RegExp;
  hasImplicitContinuationWindow: (
    chatJid: string,
    messages: NewMessage[],
  ) => boolean;
}): boolean {
  const {
    chatJid,
    messages,
    group,
    triggerPattern,
    hasImplicitContinuationWindow,
  } = opts;

  if (group.isMain === true || group.requiresTrigger === false) {
    return true;
  }

  // Paired rooms: bot-to-bot ping-pong doesn't need trigger patterns.
  // Peer bot messages (from reviewer/owner) are always allowed.
  if (hasReviewerLease(chatJid)) {
    return true;
  }

  const allowlistCfg = loadSenderAllowlist();
  const hasTrigger = messages.some(
    (message) =>
      triggerPattern.test(message.content.trim()) &&
      (message.is_from_me ||
        isTriggerAllowed(chatJid, message.sender, allowlistCfg)),
  );
  return hasTrigger || hasImplicitContinuationWindow(chatJid, messages);
}

export function getProcessableMessages(
  chatJid: string,
  messages: Parameters<typeof filterProcessableMessages>[0],
  channel?: Channel,
) {
  return filterProcessableMessages(
    messages,
    hasReviewerLease(chatJid),
    channel?.isOwnMessage?.bind(channel),
  ).filter((message) => !isTaskStatusControlMessage(message.content));
}

export function filterLoopingPairedBotMessages(
  chatJid: string,
  messages: Parameters<typeof filterProcessableMessages>[0],
  failureText: string,
) {
  if (!hasReviewerLease(chatJid)) return messages;

  return messages.filter(
    (message) =>
      !(message.is_bot_message && message.content.trim() === failureText),
  );
}
