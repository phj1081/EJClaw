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
