import { describe, expect, it } from 'vitest';

import {
  TopLevelAgentTaskTracker,
  buildTaskNotificationOutput,
  buildTaskProgressOutput,
  buildTaskStartedOutput,
} from '../src/task-progress-mapping.js';

describe('task progress mapping', () => {
  it('tracks only top-level Agent tool uses as subagents', () => {
    const tracker = new TopLevelAgentTaskTracker();

    tracker.rememberAssistantMessage({
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_top',
            name: 'Agent',
            caller: { type: 'direct' },
            input: { description: 'Find subagent enabling mechanism' },
          },
          {
            type: 'tool_use',
            id: 'toolu_nested',
            name: 'Agent',
            caller: { type: 'subagent' },
            input: { description: 'Nested helper task' },
          },
        ],
      },
    });

    const started = buildTaskStartedOutput(
      tracker,
      {
        task_id: 'task-top',
        tool_use_id: 'toolu_top',
        description: 'Find subagent enabling mechanism',
      },
      'session-1',
    );

    const nested = buildTaskStartedOutput(
      tracker,
      {
        task_id: 'task-nested',
        tool_use_id: 'toolu_nested',
        description: 'Nested helper task',
      },
      'session-1',
    );

    expect(started?.agentId).toBe('task-top');
    expect(started?.agentLabel).toBe('Find subagent enabling mechanism');
    expect(nested?.agentId).toBeUndefined();
  });

  it('keeps task progress attached to the tracked top-level subagent', () => {
    const tracker = new TopLevelAgentTaskTracker();

    tracker.rememberAssistantMessage({
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_top',
            name: 'Agent',
            caller: { type: 'direct' },
            input: { description: 'Find codex config.toml location' },
          },
        ],
      },
    });

    buildTaskStartedOutput(tracker, {
      task_id: 'task-top',
      tool_use_id: 'toolu_top',
      description: 'Find codex config.toml location',
    });

    const progress = buildTaskProgressOutput(tracker, {
      task_id: 'task-top',
      description: 'Extract exact hide_spawn_agent field names',
    });

    const notification = buildTaskNotificationOutput(tracker, {
      task_id: 'task-top',
      status: 'failed',
      summary: 'Task failed',
    });

    expect(progress?.agentId).toBe('task-top');
    expect(progress?.result).toBe('Extract exact hide_spawn_agent field names');
    expect(notification?.agentId).toBe('task-top');
    expect(notification?.agentDone).toBe(true);
  });

  it('flattens untracked internal task progress into generic progress lines', () => {
    const tracker = new TopLevelAgentTaskTracker();

    const started = buildTaskStartedOutput(tracker, {
      task_id: 'task-internal',
      tool_use_id: 'toolu_internal',
      description: 'Search Codex package for hide_spawn_agent config',
    });

    const progress = buildTaskProgressOutput(tracker, {
      task_id: 'task-internal',
      tool_use_id: 'toolu_internal',
      description: 'Extract exact hide_spawn_agent field names',
    });

    const notification = buildTaskNotificationOutput(tracker, {
      task_id: 'task-internal',
      tool_use_id: 'toolu_internal',
      status: 'completed',
      summary: 'Finished searching config',
    });

    expect(started?.agentId).toBeUndefined();
    expect(progress?.agentId).toBeUndefined();
    expect(progress?.result).toBe('Extract exact hide_spawn_agent field names');
    expect(notification?.agentId).toBeUndefined();
    expect(notification?.agentDone).toBeUndefined();
  });
});
