import { getLastHumanMessageTimestamp } from './db.js';
import { filterProcessableMessages } from './bot-message-filter.js';
import { normalizeStoredSeqCursor } from './message-cursor.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import { isTaskStatusControlMessage } from './task-watch-status.js';
import { ARBITER_AGENT_TYPE, REVIEWER_AGENT_TYPE } from './config.js';
import type { VisibleVerdict } from './paired-verdict.js';
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

export function finalizeQueuedRunCursor(args: {
  outputStatus: 'success' | 'error';
  visiblePhase: unknown;
  startSeq: number | null;
  endSeq: number | null;
  rollbackOnSilentError: boolean;
  cursorAdvanced: boolean;
  previousCursor: string | undefined;
  lastAgentTimestamps: Record<string, string>;
  saveState: () => void;
  cursorKey: string;
  log: {
    warn: (bindings: Record<string, unknown>, message: string) => void;
  };
}): boolean {
  if (
    args.rollbackOnSilentError &&
    args.outputStatus === 'error' &&
    args.visiblePhase === 'silent'
  ) {
    if (args.cursorAdvanced) {
      if (args.previousCursor === undefined) {
        delete args.lastAgentTimestamps[args.cursorKey];
      } else {
        args.lastAgentTimestamps[args.cursorKey] = args.previousCursor;
      }
      args.saveState();
    }
    args.log.warn(
      {
        messageSeqStart: args.startSeq,
        messageSeqEnd: args.endSeq,
      },
      'Queued run failed before producing visible output; keeping cursor for retry',
    );
    return false;
  }

  return true;
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

export function resolveQueuedPairedTurnRole(args: {
  taskStatus?: PairedTaskStatus | null;
  hasHumanMessage: boolean;
  lastTurnOutputRole?: PairedRoomRole | null;
  lastTurnOutputVerdict?: VisibleVerdict | null;
}): 'owner' | 'reviewer' | 'arbiter' | null {
  if (args.hasHumanMessage) {
    return resolveQueuedTurnRole({
      taskStatus: args.taskStatus,
      hasHumanMessage: true,
    });
  }

  const nextTurnAction = resolveNextTurnAction({
    taskStatus: args.taskStatus,
    lastTurnOutputRole: args.lastTurnOutputRole,
    lastTurnOutputVerdict: args.lastTurnOutputVerdict,
  });

  switch (nextTurnAction.kind) {
    case 'reviewer-turn':
      return 'reviewer';
    case 'arbiter-turn':
      return 'arbiter';
    case 'owner-follow-up':
    case 'finalize-owner-turn':
      return 'owner';
    default:
      return null;
  }
}

export type NextTurnAction =
  | { kind: 'none' }
  | { kind: 'reviewer-turn' }
  | { kind: 'arbiter-turn' }
  | { kind: 'owner-follow-up' }
  | { kind: 'finalize-owner-turn' };

export type ScheduledNextTurnActionKind = Exclude<
  NextTurnAction['kind'],
  'none'
>;

export type FollowUpDispatch =
  | { kind: 'none' }
  | { kind: 'inline' }
  | { kind: 'enqueue'; queueKind: 'paired-follow-up' | 'message-check' };

export function resolveNextTurnAction(args: {
  taskStatus?: PairedTaskStatus | null;
  lastTurnOutputRole?: PairedRoomRole | null;
  lastTurnOutputVerdict?: VisibleVerdict | null;
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
  lastTurnOutputVerdict?: VisibleVerdict | null;
  intentKind: ScheduledNextTurnActionKind;
}): boolean {
  return (
    resolveNextTurnAction({
      taskStatus: args.taskStatus,
      lastTurnOutputRole: args.lastTurnOutputRole,
      lastTurnOutputVerdict: args.lastTurnOutputVerdict,
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
        return args.nextTurnAction.kind === 'reviewer-turn' ||
          args.nextTurnAction.kind === 'arbiter-turn' ||
          args.nextTurnAction.kind === 'owner-follow-up'
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
        args.completedRole !== 'owner' &&
        args.completedRole !== 'reviewer' &&
        args.completedRole !== 'arbiter'
      ) {
        return { kind: 'none' };
      }
      return args.nextTurnAction.kind === 'reviewer-turn' ||
        args.nextTurnAction.kind === 'owner-follow-up' ||
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
  configuredReviewer: AgentType = REVIEWER_AGENT_TYPE,
  configuredArbiter: AgentType | null | undefined = ARBITER_AGENT_TYPE,
): RoleAgentPlan {
  return resolveRoleAgentPlan({
    paired,
    groupAgentType,
    configuredReviewer,
    configuredArbiter,
  });
}

/** Resolve the effective agent type for a role, considering per-role overrides. */
export function resolveEffectiveAgentType(
  role: 'owner' | 'reviewer' | 'arbiter',
  groupAgentType: AgentType | undefined,
  reviewerAgentType: AgentType = REVIEWER_AGENT_TYPE,
  arbiterAgentType: AgentType | null | undefined = ARBITER_AGENT_TYPE,
): AgentType {
  const plan = resolveConfiguredRoleAgentPlan(
    role !== 'owner',
    groupAgentType,
    reviewerAgentType,
    arbiterAgentType,
  );
  return resolveAgentTypeForRole(plan, role);
}

/** Session folder key for a role. Owner uses groupFolder, others use groupFolder:role. */
export function resolveSessionFolder(
  groupFolder: string,
  role: 'owner' | 'reviewer' | 'arbiter',
  groupAgentType: AgentType | undefined,
  reviewerAgentType: AgentType = REVIEWER_AGENT_TYPE,
  arbiterAgentType: AgentType | null | undefined = ARBITER_AGENT_TYPE,
): string {
  // Arbiter always gets a separate session — must never share with owner/reviewer
  if (role === 'arbiter') return `${groupFolder}:arbiter`;
  const plan = resolveConfiguredRoleAgentPlan(
    role !== 'owner',
    groupAgentType,
    reviewerAgentType,
    arbiterAgentType,
  );
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
  const ownerAgentType = args.lease.owner_agent_type ?? args.groupAgentType;
  const roleAgentPlan = resolveConfiguredRoleAgentPlan(
    reviewerServiceId != null,
    ownerAgentType,
    args.lease.reviewer_agent_type ?? REVIEWER_AGENT_TYPE,
    args.lease.arbiter_agent_type ?? ARBITER_AGENT_TYPE,
  );
  const configuredAgentType = resolveAgentTypeForRole(
    roleAgentPlan,
    activeRole,
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
      roleAgentPlan.ownerAgentType,
      roleAgentPlan.reviewerAgentType ?? REVIEWER_AGENT_TYPE,
      roleAgentPlan.arbiterAgentType ?? ARBITER_AGENT_TYPE,
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
