import type { ScheduledPairedFollowUpIntentKind } from './paired-follow-up-scheduler.js';
import type { NewMessage, PairedTask } from './types.js';

type JsonResponse = (
  value: unknown,
  init?: ResponseInit,
  request?: Request,
) => Response;

type InboxAction = 'run' | 'decline' | 'dismiss';

interface InboxActionRequest {
  action: InboxAction;
  requestId: string | null;
  lastOccurredAt: string | null;
}

type InboxFollowUpTask = Pick<
  PairedTask,
  'id' | 'status' | 'round_trip_count' | 'updated_at'
>;

export type InboxFollowUpScheduler = (args: {
  chatJid: string;
  runId: string;
  task: InboxFollowUpTask;
  intentKind: ScheduledPairedFollowUpIntentKind;
  enqueue: () => void;
}) => boolean;

export interface InboxDismissTracker {
  dismiss: (inboxId: string, lastOccurredAt: string | null) => void;
  isDismissed: (item: { id: string; lastOccurredAt: string }) => boolean;
}

export interface InboxActionRouteDependencies {
  dismissTracker: InboxDismissTracker;
  enqueueMessageCheck?: (chatJid: string, groupFolder: string) => void;
  loadPairedTaskById: (id: string) => PairedTask | undefined;
  messageExists: (chatJid: string, id: string) => boolean;
  mutatePairedTaskIfUnchanged: (
    id: string,
    expectedUpdatedAt: string,
    updates: Partial<
      Pick<
        PairedTask,
        'status' | 'updated_at' | 'arbiter_requested_at' | 'completion_reason'
      >
    >,
  ) => boolean;
  schedulePairedFollowUp: InboxFollowUpScheduler;
  writeChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  writeMessage: (message: NewMessage) => void;
}

interface InboxActionRouteContext extends InboxActionRouteDependencies {
  jsonResponse: JsonResponse;
  now?: () => string;
  request: Request;
  url: URL;
}

export function createInboxDismissTracker(): InboxDismissTracker {
  const dismissedInboxKeys = new Set<string>();
  return {
    dismiss: (inboxId, lastOccurredAt) => {
      dismissedInboxKeys.add(makeInboxDismissKey(inboxId, lastOccurredAt));
    },
    isDismissed: (item) =>
      dismissedInboxKeys.has(item.id) ||
      dismissedInboxKeys.has(makeInboxDismissKey(item.id, item.lastOccurredAt)),
  };
}

function parseInboxActionPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/inbox\/([^/]+)\/actions$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function parsePairedInboxTarget(
  inboxId: string,
): { taskId: string; status: PairedTask['status'] } | null {
  if (!inboxId.startsWith('paired:')) return null;
  const rest = inboxId.slice('paired:'.length);
  const separatorIndex = rest.lastIndexOf(':');
  if (separatorIndex <= 0 || separatorIndex === rest.length - 1) return null;
  const status = rest.slice(separatorIndex + 1);
  if (!isPairedTaskStatus(status)) return null;
  return {
    taskId: rest.slice(0, separatorIndex),
    status,
  };
}

function isInboxAction(value: unknown): value is InboxAction {
  return value === 'run' || value === 'decline' || value === 'dismiss';
}

function isPairedTaskStatus(value: unknown): value is PairedTask['status'] {
  return (
    value === 'active' ||
    value === 'review_ready' ||
    value === 'in_review' ||
    value === 'merge_ready' ||
    value === 'completed' ||
    value === 'arbiter_requested' ||
    value === 'in_arbitration'
  );
}

async function readInboxAction(
  request: Request,
): Promise<InboxActionRequest | null> {
  try {
    const body = (await request.json()) as {
      action?: unknown;
      requestId?: unknown;
      lastOccurredAt?: unknown;
    };
    if (!isInboxAction(body.action)) return null;
    return {
      action: body.action,
      requestId: sanitizeInboxActionRequestId(body.requestId),
      lastOccurredAt:
        typeof body.lastOccurredAt === 'string' && body.lastOccurredAt.trim()
          ? body.lastOccurredAt.trim()
          : null,
    };
  } catch {
    return null;
  }
}

function makeWebRunId(prefix: string): string {
  return `web-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeInboxActionRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);
  return safe || null;
}

function makeInboxDismissKey(
  inboxId: string,
  lastOccurredAt: string | null,
): string {
  return lastOccurredAt ? `${inboxId}\0${lastOccurredAt}` : inboxId;
}

function makeWebInboxMessageId(requestId: string | null): string {
  return requestId
    ? `web-inbox-${requestId}`
    : `web-inbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function declinedInboxMessage(status: PairedTask['status']): string {
  if (status === 'review_ready' || status === 'in_review') {
    return 'Dashboard declined review. Continue with the owner turn.';
  }
  if (status === 'merge_ready') {
    return 'Dashboard declined finalization. Continue with the owner turn.';
  }
  if (status === 'arbiter_requested' || status === 'in_arbitration') {
    return 'Dashboard declined arbiter escalation. Continue with the owner turn.';
  }
  return 'Dashboard declined this inbox item. Continue with the owner turn.';
}

function pairedFollowUpIntentForStatus(
  status: PairedTask['status'],
): ScheduledPairedFollowUpIntentKind | null {
  if (status === 'review_ready' || status === 'in_review') {
    return 'reviewer-turn';
  }
  if (status === 'merge_ready') {
    return 'finalize-owner-turn';
  }
  if (status === 'arbiter_requested' || status === 'in_arbitration') {
    return 'arbiter-turn';
  }
  return null;
}

export async function handleInboxActionRoute({
  dismissTracker,
  enqueueMessageCheck,
  jsonResponse,
  loadPairedTaskById,
  messageExists,
  mutatePairedTaskIfUnchanged,
  now,
  request,
  schedulePairedFollowUp,
  url,
  writeChatMetadata,
  writeMessage,
}: InboxActionRouteContext): Promise<Response | null> {
  const actionInboxId = parseInboxActionPath(url.pathname);
  if (!actionInboxId) return null;

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }

  const inboxRequest = await readInboxAction(request);
  if (!inboxRequest) {
    return jsonResponse({ error: 'Invalid inbox action' }, { status: 400 });
  }

  if (inboxRequest.action === 'dismiss') {
    dismissTracker.dismiss(actionInboxId, inboxRequest.lastOccurredAt);
    return jsonResponse({ ok: true, id: actionInboxId, dismissed: true });
  }

  const pairedTarget = parsePairedInboxTarget(actionInboxId);
  if (!pairedTarget) {
    return jsonResponse(
      { error: 'Unsupported inbox action target' },
      { status: 400 },
    );
  }

  if (!enqueueMessageCheck) {
    return jsonResponse(
      { error: 'Paired follow-up queue is not configured' },
      { status: 503 },
    );
  }

  const task = loadPairedTaskById(pairedTarget.taskId);
  if (!task) {
    return jsonResponse({ error: 'Paired task not found' }, { status: 404 });
  }

  if (inboxRequest.action === 'decline') {
    const messageId = makeWebInboxMessageId(inboxRequest.requestId);
    if (inboxRequest.requestId && messageExists(task.chat_jid, messageId)) {
      return jsonResponse({
        ok: true,
        id: actionInboxId,
        taskId: task.id,
        queued: false,
        duplicate: true,
      });
    }
  }

  if (task.status !== pairedTarget.status) {
    return jsonResponse(
      {
        error: 'Inbox item is stale',
        status: task.status,
      },
      { status: 409 },
    );
  }

  if (inboxRequest.action === 'decline') {
    return handleDeclineInboxAction({
      actionInboxId,
      enqueueMessageCheck,
      jsonResponse,
      messageId: makeWebInboxMessageId(inboxRequest.requestId),
      mutatePairedTaskIfUnchanged,
      now,
      task,
      writeChatMetadata,
      writeMessage,
    });
  }

  const intentKind = pairedFollowUpIntentForStatus(task.status);
  if (!intentKind) {
    return jsonResponse(
      { error: 'Paired task is not actionable' },
      { status: 409 },
    );
  }

  const queued = schedulePairedFollowUp({
    chatJid: task.chat_jid,
    runId: makeWebRunId('inbox'),
    task,
    intentKind,
    enqueue: () => enqueueMessageCheck(task.chat_jid, task.group_folder),
  });

  return jsonResponse({
    ok: true,
    id: actionInboxId,
    taskId: task.id,
    intentKind,
    queued,
  });
}

function handleDeclineInboxAction({
  actionInboxId,
  enqueueMessageCheck,
  jsonResponse,
  messageId,
  mutatePairedTaskIfUnchanged,
  now,
  task,
  writeChatMetadata,
  writeMessage,
}: {
  actionInboxId: string;
  enqueueMessageCheck: (chatJid: string, groupFolder: string) => void;
  jsonResponse: JsonResponse;
  messageId: string;
  mutatePairedTaskIfUnchanged: InboxActionRouteDependencies['mutatePairedTaskIfUnchanged'];
  now?: () => string;
  task: PairedTask;
  writeChatMetadata: InboxActionRouteDependencies['writeChatMetadata'];
  writeMessage: InboxActionRouteDependencies['writeMessage'];
}): Response {
  const timestamp = now?.() ?? new Date().toISOString();
  const updates: Partial<
    Pick<
      PairedTask,
      'status' | 'updated_at' | 'arbiter_requested_at' | 'completion_reason'
    >
  > = {
    status: 'active',
    updated_at: timestamp,
  };
  if (task.status === 'arbiter_requested' || task.status === 'in_arbitration') {
    updates.arbiter_requested_at = null;
  }

  const updated = mutatePairedTaskIfUnchanged(
    task.id,
    task.updated_at,
    updates,
  );
  if (!updated) {
    return jsonResponse(
      { error: 'Inbox item is stale', status: task.status },
      { status: 409 },
    );
  }

  writeChatMetadata(task.chat_jid, timestamp, undefined, 'web-dashboard', true);
  writeMessage({
    id: messageId,
    chat_jid: task.chat_jid,
    sender: 'web-dashboard',
    sender_name: 'Web Dashboard',
    content: declinedInboxMessage(task.status),
    timestamp,
    is_from_me: false,
    is_bot_message: false,
    message_source_kind: 'ipc_injected_human',
  });
  enqueueMessageCheck(task.chat_jid, task.group_folder);

  return jsonResponse({
    ok: true,
    id: actionInboxId,
    taskId: task.id,
    status: 'active',
    queued: true,
  });
}
