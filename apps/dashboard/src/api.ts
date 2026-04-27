export interface DashboardOverview {
  generatedAt: string;
  services: Array<{
    serviceId: string;
    assistantName: string;
    agentType: string;
    updatedAt: string;
    totalRooms: number;
    activeRooms: number;
  }>;
  rooms: {
    total: number;
    active: number;
    waiting: number;
    inactive: number;
  };
  tasks: {
    total: number;
    active: number;
    paused: number;
    completed: number;
    watchers: {
      active: number;
      paused: number;
      completed: number;
    };
  };
  usage: {
    rows: Array<{
      name: string;
      h5pct: number;
      h5reset: string;
      d7pct: number;
      d7reset: string;
    }>;
    fetchedAt: string | null;
  };
  operations?: {
    serviceRestarts: DashboardServiceRestart[];
  };
  inbox: Array<{
    id: string;
    groupKey: string;
    kind:
      | 'pending-room'
      | 'reviewer-request'
      | 'approval'
      | 'arbiter-request'
      | 'ci-failure'
      | 'mention';
    severity: 'info' | 'warn' | 'error';
    title: string;
    summary: string;
    occurredAt: string;
    lastOccurredAt: string;
    createdAt: string;
    occurrences: number;
    source: 'status-snapshot' | 'paired-task' | 'scheduled-task';
    roomJid?: string;
    roomName?: string;
    groupFolder?: string;
    serviceId?: string;
    taskId?: string;
    taskStatus?: string;
  }>;
}

export interface DashboardServiceRestart {
  id: string;
  target: 'stack';
  requestedAt: string;
  completedAt: string | null;
  status: 'running' | 'success' | 'failed';
  services: string[];
  error?: string;
}

export interface StatusSnapshot {
  serviceId: string;
  agentType: string;
  assistantName: string;
  updatedAt: string;
  entries: Array<{
    jid: string;
    name: string;
    folder: string;
    agentType: string;
    status: 'processing' | 'waiting' | 'inactive';
    elapsedMs: number | null;
    pendingMessages: boolean;
    pendingTasks: number;
  }>;
}

export interface DashboardRoomActivity {
  serviceId: string;
  jid: string;
  name: string;
  folder: string;
  agentType: string;
  status: 'processing' | 'waiting' | 'inactive';
  elapsedMs: number | null;
  pendingMessages: boolean;
  pendingTasks: number;
  messages: Array<{
    id: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
    isBotMessage: boolean;
    sourceKind: string;
  }>;
  pairedTask: {
    id: string;
    title: string | null;
    status: string;
    roundTripCount: number;
    updatedAt: string;
    currentTurn: {
      turnId: string;
      role: string;
      intentKind: string;
      state: string;
      attemptNo: number;
      executorServiceId: string | null;
      executorAgentType: string | null;
      activeRunId: string | null;
      createdAt: string;
      updatedAt: string;
      completedAt: string | null;
      lastError: string | null;
    } | null;
    outputs: Array<{
      id: number;
      turnNumber: number;
      role: string;
      verdict: string | null;
      createdAt: string;
      outputText: string;
    }>;
  } | null;
}

export interface DashboardTask {
  id: string;
  groupFolder: string;
  chatJid: string;
  agentType: string | null;
  ciProvider: string | null;
  ciMetadata: string | null;
  scheduleType: string;
  scheduleValue: string;
  contextMode: string;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  status: 'active' | 'paused' | 'completed';
  suspendedUntil: string | null;
  createdAt: string;
  promptPreview: string;
  promptLength: number;
  isWatcher: boolean;
}

export type DashboardTaskAction = 'pause' | 'resume' | 'cancel';
export type DashboardInboxAction = 'run' | 'decline' | 'dismiss';
export type DashboardServiceAction = 'restart';
export type DashboardTaskScheduleType = 'cron' | 'interval' | 'once';
export type DashboardTaskContextMode = 'group' | 'isolated';

export interface CreateScheduledTaskInput {
  roomJid: string;
  prompt: string;
  scheduleType: DashboardTaskScheduleType;
  scheduleValue: string;
  contextMode: DashboardTaskContextMode;
  requestId?: string;
}

export interface UpdateScheduledTaskInput {
  prompt?: string;
  scheduleType: DashboardTaskScheduleType;
  scheduleValue: string;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `${path} failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // Keep the status-based message when the server body is not JSON.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function fetchDashboardData(): Promise<{
  overview: DashboardOverview;
  snapshots: StatusSnapshot[];
  tasks: DashboardTask[];
}> {
  const [overview, snapshots, tasks] = await Promise.all([
    fetchJson<DashboardOverview>('/api/overview'),
    fetchJson<StatusSnapshot[]>('/api/status-snapshots'),
    fetchJson<DashboardTask[]>('/api/tasks'),
  ]);

  return { overview, snapshots, tasks };
}

export async function fetchRoomTimeline(
  roomJid: string,
): Promise<DashboardRoomActivity> {
  return fetchJson<DashboardRoomActivity>(
    `/api/rooms/${encodeURIComponent(roomJid)}/timeline`,
  );
}

export async function runScheduledTaskAction(
  taskId: string,
  action: DashboardTaskAction,
): Promise<{
  ok: true;
  id?: string;
  deleted?: boolean;
  task?: DashboardTask | null;
}> {
  return postJson(`/api/tasks/${encodeURIComponent(taskId)}/actions`, {
    action,
  });
}

export async function createScheduledTask(
  input: CreateScheduledTaskInput,
): Promise<{ ok: true; task: DashboardTask | null }> {
  return postJson('/api/tasks', input);
}

export async function updateScheduledTask(
  taskId: string,
  input: UpdateScheduledTaskInput,
): Promise<{ ok: true; task: DashboardTask | null }> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let message = `/api/tasks/${taskId} failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // Keep the status-based message when the server body is not JSON.
    }
    throw new Error(message);
  }
  return (await response.json()) as { ok: true; task: DashboardTask | null };
}

export async function runInboxAction(
  inboxId: string,
  action: DashboardInboxAction,
  options: { requestId?: string; lastOccurredAt?: string } = {},
): Promise<{
  ok: true;
  id: string;
  taskId?: string;
  intentKind?: string;
  status?: string;
  queued?: boolean;
  dismissed?: boolean;
  duplicate?: boolean;
}> {
  return postJson(`/api/inbox/${encodeURIComponent(inboxId)}/actions`, {
    action,
    lastOccurredAt: options.lastOccurredAt,
    requestId: options.requestId,
  });
}

export async function runServiceAction(
  serviceId: 'stack',
  action: DashboardServiceAction,
  options: { requestId?: string } = {},
): Promise<{
  ok: true;
  duplicate?: boolean;
  restart: DashboardServiceRestart;
}> {
  return postJson(`/api/services/${encodeURIComponent(serviceId)}/actions`, {
    action,
    requestId: options.requestId,
  });
}

export async function sendRoomMessage(
  roomJid: string,
  text: string,
  requestId: string,
): Promise<{ ok: true; id: string; queued: boolean }> {
  return postJson(`/api/rooms/${encodeURIComponent(roomJid)}/messages`, {
    requestId,
    text,
  });
}
