import {
  normalizeStructuredOutput,
  type RunnerOutput,
} from './output-protocol.js';

type AssistantToolUseBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  caller?: { type?: unknown } | null;
  input?: { description?: unknown } | null;
};

type AssistantMessageLike = {
  type?: unknown;
  message?: {
    content?: unknown;
  };
};

type TaskLike = {
  task_id?: unknown;
  tool_use_id?: unknown;
  description?: unknown;
  status?: unknown;
  summary?: unknown;
};

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function getTaskText(message: TaskLike): {
  taskId?: string;
  toolUseId?: string;
  description?: string;
  summary?: string;
} {
  return {
    taskId: toNonEmptyString(message.task_id),
    toolUseId: toNonEmptyString(message.tool_use_id),
    description: toNonEmptyString(message.description),
    summary: toNonEmptyString(message.summary),
  };
}

export class TopLevelAgentTaskTracker {
  private readonly topLevelToolUses = new Map<string, string>();
  private readonly taskLabels = new Map<string, string>();

  rememberAssistantMessage(message: unknown): void {
    const assistant = message as AssistantMessageLike;
    const blocks = assistant.message?.content;
    if (!Array.isArray(blocks)) return;

    for (const block of blocks) {
      const toolUse = block as AssistantToolUseBlock;
      if (toolUse.type !== 'tool_use' || toolUse.name !== 'Agent') continue;

      const toolUseId = toNonEmptyString(toolUse.id);
      if (!toolUseId) continue;

      const callerType = toolUse.caller?.type;
      if (callerType !== undefined && callerType !== 'direct') continue;

      const description =
        toNonEmptyString(toolUse.input?.description) || '서브에이전트 작업';
      this.topLevelToolUses.set(toolUseId, description);
    }
  }

  resolveTask(message: TaskLike): {
    tracked: boolean;
    taskId?: string;
    label?: string;
  } {
    const { taskId, toolUseId, description } = getTaskText(message);
    if (!taskId) {
      return { tracked: false };
    }

    const existing = this.taskLabels.get(taskId);
    if (existing) {
      return { tracked: true, taskId, label: existing };
    }

    if (toolUseId) {
      const topLevelLabel = this.topLevelToolUses.get(toolUseId);
      if (topLevelLabel) {
        const label = topLevelLabel || description || '서브에이전트 작업';
        this.taskLabels.set(taskId, label);
        return { tracked: true, taskId, label };
      }
    }

    return { tracked: false, taskId, label: description };
  }
}

export function buildTaskStartedOutput(
  tracker: TopLevelAgentTaskTracker,
  message: TaskLike,
  newSessionId?: string,
): RunnerOutput | null {
  const { description } = getTaskText(message);
  if (!description) return null;

  const resolved = tracker.resolveTask(message);
  const label = resolved.label || description;
  const normalized = normalizeStructuredOutput(`🔄 ${label}`);

  return {
    status: 'success',
    phase: 'progress',
    ...normalized,
    ...(resolved.tracked && resolved.taskId
      ? {
          agentId: resolved.taskId,
          agentLabel: label,
        }
      : {}),
    newSessionId,
  };
}

export function buildTaskProgressOutput(
  tracker: TopLevelAgentTaskTracker,
  message: TaskLike,
  newSessionId?: string,
): RunnerOutput | null {
  const { description } = getTaskText(message);
  if (!description || description.length > 80) return null;

  const resolved = tracker.resolveTask(message);
  const normalized = normalizeStructuredOutput(description);

  return {
    status: 'success',
    phase: 'tool-activity',
    ...normalized,
    ...(resolved.tracked && resolved.taskId
      ? {
          agentId: resolved.taskId,
        }
      : {}),
    newSessionId,
  };
}

export function buildTaskNotificationOutput(
  tracker: TopLevelAgentTaskTracker,
  message: TaskLike,
  newSessionId?: string,
): RunnerOutput | null {
  const { summary } = getTaskText(message);
  const status = toNonEmptyString(message.status);
  if (!status) return null;
  if (
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'stopped' &&
    status !== 'error' &&
    status !== 'cancelled'
  ) {
    return null;
  }

  const resolved = tracker.resolveTask(message);

  return {
    status: 'success',
    phase: 'progress',
    ...(summary !== undefined
      ? {
          ...normalizeStructuredOutput(summary),
        }
      : { result: null }),
    ...(resolved.tracked && resolved.taskId
      ? {
          agentId: resolved.taskId,
          agentDone: true,
        }
      : {}),
    newSessionId,
  };
}
