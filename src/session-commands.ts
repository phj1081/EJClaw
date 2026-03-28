import { getAgentOutputText } from './agent-output.js';
import type { NewMessage } from './types.js';
import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import type { StructuredAgentOutput } from './types.js';

const SESSION_COMMAND_CONTROL_PATTERNS = [
  /^Current session cleared\. The next message will start a new conversation\.$/,
  /^Session commands require admin access\.$/,
  /^Failed to process messages before \/compact\. Try again\.$/,
  /^\/compact failed\. The session is unchanged\.$/,
  /^Conversation compacted\.$/,
  /^Review snapshot updated\.(?:\n|$)/,
  /^Review request recorded, but the owner workspace is not ready yet\.(?:\n|$)/,
  /^Plan review is required before formal review for this high-risk task\.(?:\n|$)/,
  /^Task risk updated\.(?:\n|$)/,
  /^Plan recorded\.(?:\n|$)/,
  /^Plan approved\.(?:\n|$)/,
  /^Plan changes requested\.(?:\n|$)/,
  /^Risk updates must be handled by the owner service\.$/,
  /^Plan recording must be handled by the owner service\.$/,
  /^Plan approval must be handled by the reviewer service\.$/,
  /^Plan review commands are only required for high-risk tasks\.$/,
  /^Plan artifacts are incomplete\.(?:\n|$)/,
  /^Review is unavailable for this room\./,
];

function normalizeSessionCommandText(
  content: string,
  triggerPattern: RegExp,
): string {
  return content.trim().replace(triggerPattern, '').trim();
}

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the slash command (e.g., '/compact') or null if not a session command.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): string | null {
  const text = normalizeSessionCommandText(content, triggerPattern);
  if (text === '/compact') return '/compact';
  if (text === '/clear') return '/clear';
  if (text === '/review' || text === '/review-ready') return '/review';
  if (/^\/risk(?:\s|$)/.test(text)) return '/risk';
  if (/^\/plan(?:\s|$)/.test(text)) return '/plan';
  if (text === '/approve-plan') return '/approve-plan';
  if (/^\/request-plan-changes(?:\s|$)/.test(text)) {
    return '/request-plan-changes';
  }
  return null;
}

/**
 * Check if a session command sender is authorized.
 * Allowed: main group (any sender), or trusted/admin sender in any group.
 */
export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
  isAdminSender: boolean = false,
): boolean {
  return isMainGroup || isFromMe || isAdminSender;
}

export function isSessionCommandControlMessage(content: string): boolean {
  const trimmed = content.trim();
  return SESSION_COMMAND_CONTROL_PATTERNS.some((pattern) =>
    pattern.test(trimmed),
  );
}

/** Minimal agent result interface — matches the subset of AgentOutput used here. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
  output?: StructuredAgentOutput;
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  clearSession: () => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  isAdminSender: (msg: NewMessage) => boolean;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
  markReviewReady: (dedupeKey: string) => Promise<string | null>;
  setTaskRiskLevel: (
    riskLevel: 'low' | 'high',
    dedupeKey: string,
  ) => Promise<string | null>;
  recordPlan: (plan: {
    planBrief: string;
    acceptanceCriteria: string;
    riskSummary: string;
  }, dedupeKey: string) => Promise<string | null>;
  approvePlan: (dedupeKey: string) => Promise<string | null>;
  requestPlanChanges: (
    note: string | undefined,
    dedupeKey: string,
  ) => Promise<string | null>;
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return formatOutbound(raw);
}

function agentResultToText(result: AgentResult): string {
  const raw = getAgentOutputText({
    result: result.result ?? null,
    output: result.output,
  });
  return raw ? formatOutbound(raw) : '';
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  runId?: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    runId,
    triggerPattern,
    timezone,
    deps,
  } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;
  const normalizedCommandText = cmdMsg
    ? normalizeSessionCommandText(cmdMsg.content, triggerPattern)
    : '';

  if (!command || !cmdMsg) return { handled: false };

  if (
    !isSessionCommandAllowed(
      isMainGroup,
      cmdMsg.is_from_me === true,
      deps.isAdminSender(cmdMsg),
    )
  ) {
    // DENIED: send denial if the sender would normally be allowed to interact,
    // then silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // AUTHORIZED: process pre-compact messages first, then run the command
  logger.info({ group: groupName, runId, command }, 'Session command');

  if (command === '/clear') {
    deps.closeStdin();
    deps.clearSession();
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.sendMessage(
      'Current session cleared. The next message will start a new conversation.',
    );
    return { handled: true, success: true };
  }

  if (command === '/review') {
    const result = await deps.markReviewReady(cmdMsg.id);
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.sendMessage(
      result ??
        'Review is unavailable for this room. Paired workspaces require a configured project workDir.',
    );
    return { handled: true, success: true };
  }

  if (command === '/risk') {
    const riskArg = normalizedCommandText
      .slice('/risk'.length)
      .trim()
      .toLowerCase();
    const riskLevel =
      riskArg === 'high' ? 'high' : riskArg === 'low' ? 'low' : null;
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.sendMessage(
      riskLevel
        ? ((await deps.setTaskRiskLevel(riskLevel, cmdMsg.id)) ??
            'Risk is unavailable for this room.')
        : 'Usage: /risk <low|high>',
    );
    return { handled: true, success: true };
  }

  if (command === '/plan') {
    const payload = normalizedCommandText.slice('/plan'.length).trim();
    const parts = payload.split('||').map((part) => part.trim());
    deps.advanceCursor(cmdMsg.timestamp);
    if (parts.length !== 3 || parts.some((part) => !part)) {
      await deps.sendMessage(
        'Usage: /plan <plan brief> || <acceptance criteria> || <risk summary>',
      );
      return { handled: true, success: true };
    }
    await deps.sendMessage(
      (await deps.recordPlan({
        planBrief: parts[0],
        acceptanceCriteria: parts[1],
        riskSummary: parts[2],
      }, cmdMsg.id)) ?? 'Plan recording is unavailable for this room.',
    );
    return { handled: true, success: true };
  }

  if (command === '/approve-plan') {
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.sendMessage(
      (await deps.approvePlan(cmdMsg.id)) ??
        'Plan approval is unavailable for this room.',
    );
    return { handled: true, success: true };
  }

  if (command === '/request-plan-changes') {
    const note = normalizedCommandText
      .slice('/request-plan-changes'.length)
      .trim();
    deps.advanceCursor(cmdMsg.timestamp);
    await deps.sendMessage(
      (await deps.requestPlanChanges(note || undefined, cmdMsg.id)) ??
        'Plan change requests are unavailable for this room.',
    );
    return { handled: true, success: true };
  }

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCompactMsgs = missedMessages.slice(0, cmdIndex);

  // Send pre-compact messages to the agent so they're in the session context.
  if (preCompactMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCompactMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = agentResultToText(result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
      // Close stdin on session-update marker — emitted after query completes,
      // so all results (including multi-result runs) are already written.
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName, runId },
        'Pre-compact processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command}. Try again.`,
      );
      if (preOutputSent) {
        // Output was already sent — don't retry or it will duplicate.
        // Advance cursor past pre-compact messages, leave command pending.
        deps.advanceCursor(preCompactMsgs[preCompactMsgs.length - 1].timestamp);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  await deps.setTyping(true);

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = agentResultToText(result);
    if (text) await deps.sendMessage(text);
  });

  // Advance cursor to the command — messages AFTER it remain pending for next poll.
  deps.advanceCursor(cmdMsg.timestamp);
  await deps.setTyping(false);

  if (cmdOutput === 'error' || hadCmdError) {
    await deps.sendMessage(`${command} failed. The session is unchanged.`);
  }

  return { handled: true, success: true };
}
