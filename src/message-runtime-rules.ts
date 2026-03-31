import { getLastHumanMessageTimestamp } from './db.js';
import { filterProcessableMessages } from './bot-message-filter.js';
import { normalizeStoredSeqCursor } from './message-cursor.js';
import { isTriggerAllowed, loadSenderAllowlist } from './sender-allowlist.js';
import { isTaskStatusControlMessage } from './task-watch-status.js';
import { ARBITER_AGENT_TYPE, REVIEWER_AGENT_TYPE } from './config.js';
import { hasReviewerLease } from './service-routing.js';
import {
  resolveAgentTypeForRole,
  resolveRoleAgentPlan,
  type RoleAgentPlan,
} from './role-agent-plan.js';
import {
  type AgentType,
  type Channel,
  type NewMessage,
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

/** Cursor key for a role. Owner uses chatJid, others use chatJid:role. */
export function resolveCursorKey(
  chatJid: string,
  taskStatus?: string | null,
): string {
  if (!hasReviewerLease(chatJid)) return chatJid;
  const role = resolveActiveRole(taskStatus);
  return role === 'owner' ? chatJid : `${chatJid}:${role}`;
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
