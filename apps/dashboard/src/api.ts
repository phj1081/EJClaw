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
    attachments?: Array<{
      path: string;
      name?: string;
      mime?: string;
    }>;
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
      progressText: string | null;
      progressUpdatedAt: string | null;
    } | null;
    outputs: Array<{
      id: number;
      turnNumber: number;
      role: string;
      verdict: string | null;
      createdAt: string;
      outputText: string;
      attachments?: Array<{
        path: string;
        name?: string;
        mime?: string;
      }>;
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

export async function fetchRoomsTimelineBatch(): Promise<
  Record<string, DashboardRoomActivity>
> {
  return fetchJson<Record<string, DashboardRoomActivity>>(
    '/api/rooms-timeline',
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
  nickname?: string | null,
): Promise<{ ok: true; id: string; queued: boolean }> {
  return postJson(`/api/rooms/${encodeURIComponent(roomJid)}/messages`, {
    requestId,
    text,
    nickname: nickname ?? undefined,
  });
}

export interface ClaudeAccountSummary {
  index: number;
  expiresAt: number | null;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  exists: boolean;
}

export interface CodexAccountSummary {
  index: number;
  accountId: string | null;
  email: string | null;
  planType: string | null;
  subscriptionUntil: string | null;
  subscriptionLastChecked: string | null;
  exists: boolean;
}

export interface ModelRoleConfig {
  model: string;
  effort: string;
}

export interface ModelConfigSnapshot {
  owner: ModelRoleConfig;
  reviewer: ModelRoleConfig;
  arbiter: ModelRoleConfig;
}

export interface FastModeSnapshot {
  codex: boolean;
  claude: boolean;
}

export interface CodexFeatureSnapshot {
  goals: boolean;
}

export interface RuntimePathSnapshot {
  label: string;
  path: string;
  exists: boolean;
}

export interface RuntimeSkillSummary {
  name: string;
  description: string | null;
  path: string;
}

export interface RuntimeSkillDirSnapshot extends RuntimePathSnapshot {
  count: number;
  skills: RuntimeSkillSummary[];
}

export interface RuntimeMcpSnapshot {
  configPath: RuntimePathSnapshot;
  ejclawConfigured: boolean;
  serverCount: number;
}

export interface RuntimeAgentInventory {
  configFiles: RuntimePathSnapshot[];
  skillDirs: RuntimeSkillDirSnapshot[];
  mcp: RuntimeMcpSnapshot;
}

export interface RuntimeInventorySnapshot {
  generatedAt: string;
  projectRoot: string;
  dataDir: string;
  service: {
    id: string;
    sessionScope: string;
    agentType: string;
  };
  codex: RuntimeAgentInventory;
  claude: RuntimeAgentInventory;
  ejclaw: {
    runnerSkillDir: RuntimeSkillDirSnapshot;
    mcpServer: RuntimePathSnapshot;
  };
}

export type RoomSkillScope = 'codex-user' | 'claude-user' | 'runner';

export interface RoomSkillCatalogItem {
  id: string;
  scope: RoomSkillScope;
  name: string;
  displayName: string;
  description: string | null;
  path: string;
  agentTypes: Array<'claude-code' | 'codex'>;
}

export interface RoomSkillAgentPolicy {
  agentType: 'claude-code' | 'codex';
  mode: 'all-enabled' | 'custom';
  availableSkillIds: string[];
  disabledSkillIds: string[];
  explicitEnabledSkillIds: string[];
  effectiveEnabledSkillIds: string[];
}

export interface RoomSkillPolicyRoom {
  jid: string;
  name: string;
  folder: string;
  roomMode?: 'single' | 'tribunal';
  agents: RoomSkillAgentPolicy[];
}

export interface RoomSkillSettingsSnapshot {
  generatedAt: string;
  catalog: RoomSkillCatalogItem[];
  rooms: RoomSkillPolicyRoom[];
}

export interface RoomSkillSettingUpdateInput {
  roomJid: string;
  agentType: 'claude-code' | 'codex';
  skillId: string;
  enabled: boolean;
}

export interface MoaReferenceStatus {
  model: string;
  checkedAt: string;
  ok: boolean;
  error: string | null;
  responseLength?: number;
}

export interface MoaModelSettingsSnapshot {
  name: string;
  enabled: boolean;
  model: string;
  baseUrl: string;
  apiFormat: 'openai' | 'anthropic';
  apiKeyConfigured: boolean;
  lastStatus: MoaReferenceStatus | null;
}

export interface MoaSettingsSnapshot {
  enabled: boolean;
  referenceModels: string[];
  models: MoaModelSettingsSnapshot[];
}

export async function fetchAccounts(): Promise<{
  claude: ClaudeAccountSummary[];
  codex: CodexAccountSummary[];
  codexCurrentIndex?: number;
}> {
  return fetchJson('/api/settings/accounts');
}

export async function fetchModelConfig(): Promise<ModelConfigSnapshot> {
  return fetchJson('/api/settings/models');
}

export async function updateModels(
  input: Partial<{
    owner: Partial<ModelRoleConfig>;
    reviewer: Partial<ModelRoleConfig>;
    arbiter: Partial<ModelRoleConfig>;
  }>,
): Promise<ModelConfigSnapshot> {
  const response = await fetch('/api/settings/models', {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let msg = `update models failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) msg = payload.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await response.json()) as ModelConfigSnapshot;
}

export async function refreshCodexAccount(
  index: number,
): Promise<CodexAccountSummary> {
  const response = await fetch(
    `/api/settings/accounts/codex/${index}/refresh`,
    { method: 'POST' },
  );
  if (!response.ok) {
    let msg = `refresh failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) msg = payload.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const json = (await response.json()) as { account: CodexAccountSummary };
  return json.account;
}

export async function refreshAllCodexAccounts(): Promise<{
  refreshed: number[];
  failed: Array<{ index: number; error: string }>;
}> {
  const response = await fetch('/api/settings/accounts/codex/refresh-all', {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`refresh-all failed: ${response.status}`);
  }
  return (await response.json()) as {
    refreshed: number[];
    failed: Array<{ index: number; error: string }>;
  };
}

export async function setCurrentCodexAccount(
  index: number,
): Promise<{ codexCurrentIndex: number }> {
  const response = await fetch('/api/settings/accounts/codex/current', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ index }),
  });
  if (!response.ok) {
    let msg = `switch failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) msg = payload.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await response.json()) as { codexCurrentIndex: number };
}

export async function fetchFastMode(): Promise<FastModeSnapshot> {
  return fetchJson('/api/settings/fast-mode');
}

export async function updateFastMode(
  input: Partial<FastModeSnapshot>,
): Promise<FastModeSnapshot> {
  const response = await fetch('/api/settings/fast-mode', {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let msg = `update fast mode failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) msg = payload.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await response.json()) as FastModeSnapshot;
}

export async function fetchCodexFeatures(): Promise<CodexFeatureSnapshot> {
  return fetchJson('/api/settings/codex-features');
}

export async function fetchRuntimeInventory(): Promise<RuntimeInventorySnapshot> {
  return fetchJson('/api/settings/runtime-inventory');
}

export async function fetchRoomSkillSettings(): Promise<RoomSkillSettingsSnapshot> {
  return fetchJson('/api/settings/room-skills');
}

export async function updateRoomSkillSetting(
  input: RoomSkillSettingUpdateInput,
): Promise<RoomSkillSettingsSnapshot> {
  const response = await fetch('/api/settings/room-skills', {
    method: 'PATCH',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let msg = `update room skill failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) msg = payload.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await response.json()) as RoomSkillSettingsSnapshot;
}

export async function updateCodexFeatures(
  input: Partial<CodexFeatureSnapshot>,
): Promise<CodexFeatureSnapshot> {
  const response = await fetch('/api/settings/codex-features', {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let msg = `update codex features failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) msg = payload.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await response.json()) as CodexFeatureSnapshot;
}

export async function fetchMoaSettings(): Promise<MoaSettingsSnapshot> {
  return fetchJson('/api/settings/moa');
}

export async function updateMoaSettings(input: {
  enabled?: boolean;
  models?: Array<{
    name: string;
    enabled?: boolean;
    model?: string;
    baseUrl?: string;
    apiFormat?: 'openai' | 'anthropic';
    apiKey?: string;
  }>;
}): Promise<MoaSettingsSnapshot> {
  const response = await fetch('/api/settings/moa', {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let msg = `update MoA settings failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) msg = payload.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await response.json()) as MoaSettingsSnapshot;
}

export async function checkMoaModel(name: string): Promise<MoaReferenceStatus> {
  const response = await fetch('/api/settings/moa/check', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    let msg = `check MoA model failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) msg = payload.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const payload = (await response.json()) as {
    status: MoaReferenceStatus;
  };
  return payload.status;
}

export async function deleteAccount(
  provider: 'claude' | 'codex',
  index: number,
): Promise<{ ok: true; provider: string; index: number }> {
  const response = await fetch(`/api/settings/accounts/${provider}/${index}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    let msg = `delete account failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) msg = payload.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await response.json()) as {
    ok: true;
    provider: string;
    index: number;
  };
}

export async function addClaudeAccount(
  token: string,
): Promise<{ ok: true; index: number; accountId: string | null }> {
  return postJson('/api/settings/accounts/claude', { token });
}
