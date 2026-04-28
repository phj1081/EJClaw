import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';
import { isWatchCiTask } from './task-watch-status.js';
import type { AgentType, RegisteredGroup, ScheduledTask } from './types.js';
import { sanitizeScheduledTask } from './web-dashboard-data.js';

type JsonResponse = (
  value: unknown,
  init?: ResponseInit,
  request?: Request,
) => Response;

type TaskAction = 'pause' | 'resume' | 'cancel';

interface ScheduledTaskMutationBody {
  roomJid?: unknown;
  groupFolder?: unknown;
  prompt?: unknown;
  scheduleType?: unknown;
  scheduleValue?: unknown;
  contextMode?: unknown;
  agentType?: unknown;
  requestId?: unknown;
}

type ScheduledTaskCreateInput = Pick<
  ScheduledTask,
  | 'id'
  | 'group_folder'
  | 'chat_jid'
  | 'prompt'
  | 'schedule_type'
  | 'schedule_value'
  | 'context_mode'
  | 'next_run'
  | 'status'
  | 'created_at'
> & {
  agent_type?: AgentType | null;
};

type ScheduledTaskUpdateInput = Partial<
  Pick<
    ScheduledTask,
    | 'prompt'
    | 'schedule_type'
    | 'schedule_value'
    | 'next_run'
    | 'status'
    | 'suspended_until'
  >
>;

export interface ScheduledTaskRouteDependencies {
  createScheduledTask: (task: ScheduledTaskCreateInput) => void;
  loadRoomBindings?: () => Record<string, RegisteredGroup>;
  loadTaskById: (id: string) => ScheduledTask | undefined;
  mutateTask: (id: string, updates: ScheduledTaskUpdateInput) => void;
  nudgeScheduler?: () => void;
  removeTask: (id: string) => void;
}

interface ScheduledTaskRouteContext extends ScheduledTaskRouteDependencies {
  url: URL;
  request: Request;
  jsonResponse: JsonResponse;
  now?: () => string;
}

const WEB_TASK_PROMPT_MAX_LENGTH = 8000;

function parseTaskPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function parseTaskActionPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/tasks\/([^/]+)\/actions$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function isTaskAction(value: unknown): value is TaskAction {
  return value === 'pause' || value === 'resume' || value === 'cancel';
}

function isScheduleType(
  value: unknown,
): value is ScheduledTask['schedule_type'] {
  return value === 'cron' || value === 'interval' || value === 'once';
}

function isContextMode(value: unknown): value is ScheduledTask['context_mode'] {
  return value === 'group' || value === 'isolated';
}

function isAgentType(value: unknown): value is AgentType {
  return value === 'claude-code' || value === 'codex';
}

async function readTaskAction(request: Request): Promise<TaskAction | null> {
  try {
    const body = (await request.json()) as { action?: unknown };
    return isTaskAction(body.action) ? body.action : null;
  } catch {
    return null;
  }
}

async function readScheduledTaskMutationBody(
  request: Request,
): Promise<ScheduledTaskMutationBody | null> {
  try {
    return (await request.json()) as ScheduledTaskMutationBody;
  } catch {
    return null;
  }
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeTaskPrompt(value: unknown): string | null {
  const prompt = normalizeNonEmptyString(value);
  if (!prompt) return null;
  return prompt.length > WEB_TASK_PROMPT_MAX_LENGTH
    ? prompt.slice(0, WEB_TASK_PROMPT_MAX_LENGTH)
    : prompt;
}

function computeInitialNextRun(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
  nowIso: string,
): { nextRun: string | null; error?: string } {
  if (scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(scheduleValue, {
        tz: TIMEZONE,
      });
      return { nextRun: interval.next().toISOString() };
    } catch {
      return { nextRun: null, error: 'Invalid cron schedule' };
    }
  }

  if (scheduleType === 'interval') {
    const ms = Number.parseInt(scheduleValue, 10);
    if (!Number.isFinite(ms) || ms <= 0) {
      return { nextRun: null, error: 'Invalid interval schedule' };
    }
    return {
      nextRun: new Date(new Date(nowIso).getTime() + ms).toISOString(),
    };
  }

  const date = new Date(scheduleValue);
  if (Number.isNaN(date.getTime())) {
    return { nextRun: null, error: 'Invalid timestamp schedule' };
  }
  return { nextRun: date.toISOString() };
}

function resolveTaskRoom(
  body: ScheduledTaskMutationBody,
  roomBindings: Record<string, RegisteredGroup>,
): { chatJid: string; group: RegisteredGroup } | null {
  const roomJid = normalizeNonEmptyString(body.roomJid);
  const groupFolder = normalizeNonEmptyString(body.groupFolder);
  if (roomJid && roomBindings[roomJid]) {
    return { chatJid: roomJid, group: roomBindings[roomJid] };
  }
  if (groupFolder) {
    const match = Object.entries(roomBindings).find(
      ([, group]) => group.folder === groupFolder,
    );
    if (match) return { chatJid: match[0], group: match[1] };
  }
  return null;
}

function makeWebTaskId(): string {
  return `web-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeScheduledTaskRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const safe = trimmed.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);
  return safe || null;
}

function makeWebTaskIdFromRequest(requestId: string | null): string {
  return requestId ? `web-task-${requestId}` : makeWebTaskId();
}

async function handleTaskActionRoute(
  context: ScheduledTaskRouteContext,
  taskId: string,
): Promise<Response> {
  const { request, jsonResponse, loadTaskById, mutateTask, removeTask } =
    context;
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
  }

  const action = await readTaskAction(request);
  if (!action) {
    return jsonResponse({ error: 'Invalid task action' }, { status: 400 });
  }

  const task = loadTaskById(taskId);
  if (!task) {
    return jsonResponse({ error: 'Task not found' }, { status: 404 });
  }

  if (task.status === 'completed' && action !== 'cancel') {
    return jsonResponse(
      { error: 'Completed tasks cannot be changed' },
      { status: 409 },
    );
  }

  if (action === 'cancel') {
    removeTask(taskId);
    return jsonResponse({ ok: true, id: taskId, deleted: true });
  }

  mutateTask(taskId, {
    status: action === 'pause' ? 'paused' : 'active',
    suspended_until: null,
  });

  const updatedTask = loadTaskById(taskId);
  return jsonResponse({
    ok: true,
    task: updatedTask ? sanitizeScheduledTask(updatedTask) : null,
  });
}

async function handleTaskCreateRoute(
  context: ScheduledTaskRouteContext,
): Promise<Response> {
  const {
    createScheduledTask,
    jsonResponse,
    loadRoomBindings,
    loadTaskById,
    nudgeScheduler,
    request,
    now,
  } = context;
  if (!loadRoomBindings) {
    return jsonResponse(
      { error: 'Task creation is not configured' },
      { status: 503 },
    );
  }

  const body = await readScheduledTaskMutationBody(request);
  const prompt = normalizeTaskPrompt(body?.prompt);
  const scheduleType =
    body && isScheduleType(body.scheduleType) ? body.scheduleType : null;
  const scheduleValue = normalizeNonEmptyString(body?.scheduleValue);
  if (!body || !prompt || !scheduleType || !scheduleValue) {
    return jsonResponse(
      { error: 'Task prompt, schedule type, and schedule value are required' },
      { status: 400 },
    );
  }

  const room = resolveTaskRoom(body, loadRoomBindings());
  if (!room) {
    return jsonResponse({ error: 'Room not found' }, { status: 404 });
  }

  const nowIso = now?.() ?? new Date().toISOString();
  const next = computeInitialNextRun(scheduleType, scheduleValue, nowIso);
  if (next.error) {
    return jsonResponse({ error: next.error }, { status: 400 });
  }

  const contextMode = isContextMode(body.contextMode)
    ? body.contextMode
    : 'isolated';
  const agentType = isAgentType(body.agentType)
    ? body.agentType
    : (room.group.agentType ?? 'claude-code');
  const requestId = sanitizeScheduledTaskRequestId(body.requestId);
  const id = makeWebTaskIdFromRequest(requestId);
  const existing = requestId ? loadTaskById(id) : undefined;
  if (existing) {
    return jsonResponse({
      ok: true,
      duplicate: true,
      task: sanitizeScheduledTask(existing),
    });
  }

  createScheduledTask({
    id,
    group_folder: room.group.folder,
    chat_jid: room.chatJid,
    agent_type: agentType,
    prompt,
    schedule_type: scheduleType,
    schedule_value: scheduleValue,
    context_mode: contextMode,
    next_run: next.nextRun,
    status: 'active',
    created_at: nowIso,
  });

  const created = loadTaskById(id);
  if (
    next.nextRun &&
    new Date(next.nextRun).getTime() <= new Date(nowIso).getTime()
  ) {
    nudgeScheduler?.();
  }
  return jsonResponse({
    ok: true,
    task: created ? sanitizeScheduledTask(created) : null,
  });
}

async function handleTaskUpdateRoute(
  context: ScheduledTaskRouteContext,
  taskId: string,
): Promise<Response> {
  const { jsonResponse, loadTaskById, mutateTask, request, now } = context;
  const task = loadTaskById(taskId);
  if (!task) {
    return jsonResponse({ error: 'Task not found' }, { status: 404 });
  }
  if (task.status === 'completed') {
    return jsonResponse(
      { error: 'Completed tasks cannot be edited' },
      { status: 409 },
    );
  }
  if (isWatchCiTask(task)) {
    return jsonResponse(
      { error: 'CI watchers cannot be edited here' },
      { status: 409 },
    );
  }

  const body = await readScheduledTaskMutationBody(request);
  if (!body) {
    return jsonResponse({ error: 'Invalid task update' }, { status: 400 });
  }
  if (
    body.roomJid !== undefined ||
    body.groupFolder !== undefined ||
    body.contextMode !== undefined ||
    body.agentType !== undefined
  ) {
    return jsonResponse(
      { error: 'Task room, context, and agent cannot be edited here' },
      { status: 400 },
    );
  }

  const prompt =
    body.prompt === undefined ? task.prompt : normalizeTaskPrompt(body.prompt);
  const scheduleChanged =
    body.scheduleType !== undefined || body.scheduleValue !== undefined;
  const scheduleType =
    body.scheduleType === undefined
      ? task.schedule_type
      : isScheduleType(body.scheduleType)
        ? body.scheduleType
        : null;
  const scheduleValue =
    body.scheduleValue === undefined
      ? task.schedule_value
      : normalizeNonEmptyString(body.scheduleValue);
  if (!prompt || !scheduleType || !scheduleValue) {
    return jsonResponse({ error: 'Invalid task update' }, { status: 400 });
  }

  const updates: ScheduledTaskUpdateInput = {
    prompt,
    schedule_type: scheduleType,
    schedule_value: scheduleValue,
  };

  if (scheduleChanged) {
    const next = computeInitialNextRun(
      scheduleType,
      scheduleValue,
      now?.() ?? new Date().toISOString(),
    );
    if (next.error) {
      return jsonResponse({ error: next.error }, { status: 400 });
    }
    updates.next_run = next.nextRun;
    updates.suspended_until = null;
  }

  mutateTask(taskId, updates);
  const updatedTask = loadTaskById(taskId);
  return jsonResponse({
    ok: true,
    task: updatedTask ? sanitizeScheduledTask(updatedTask) : null,
  });
}

export async function handleScheduledTaskRoute(
  context: ScheduledTaskRouteContext,
): Promise<Response | null> {
  const { request, url } = context;
  const actionTaskId = parseTaskActionPath(url.pathname);
  if (actionTaskId) return handleTaskActionRoute(context, actionTaskId);

  if (url.pathname === '/api/tasks' && request.method === 'POST') {
    return handleTaskCreateRoute(context);
  }

  const taskId = parseTaskPath(url.pathname);
  if (taskId && request.method === 'PATCH') {
    return handleTaskUpdateRoute(context, taskId);
  }

  return null;
}
