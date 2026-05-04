import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DashboardTask } from './api';
import { messages } from './i18n';
import { TaskPanel, type TaskPanelProps } from './TaskPanel';

const t = messages.en;

const task: DashboardTask = {
  agentType: 'codex',
  chatJid: 'room-1',
  ciMetadata: null,
  ciProvider: null,
  contextMode: 'group',
  createdAt: '2026-04-28T04:00:00.000Z',
  groupFolder: 'eyejokerdb',
  id: 'task-1',
  isWatcher: false,
  lastResult: '<internal>hidden</internal>Task completed',
  lastRun: '2026-04-28T04:30:00.000Z',
  nextRun: '2026-04-28T05:00:00.000Z',
  promptLength: 42,
  promptPreview: '<internal>hidden</internal>Run production check',
  scheduleType: 'interval',
  scheduleValue: '10m',
  status: 'active',
  suspendedUntil: null,
};

const baseProps: TaskPanelProps = {
  locale: 'en',
  onTaskAction: () => {},
  onTaskCreate: () => {},
  onTaskUpdate: () => {},
  rooms: [{ folder: 'eyejokerdb', jid: 'room-1', name: 'eyejokerdb-main' }],
  taskActionKey: null,
  tasks: [task],
  t,
};

describe('TaskPanel', () => {
  it('renders task groups, actions, and sanitized previews', () => {
    const html = renderToStaticMarkup(createElement(TaskPanel, baseProps));

    expect(html).toContain(t.tasks.groups.scheduled);
    expect(html).toContain('eyejokerdb-main');
    expect(html).toContain(t.panels.scheduled);
    expect(html).toContain(t.tasks.next);
    expect(html).toContain('10m');
    expect(html).toContain(t.tasks.actions.pause);
    expect(html).toContain(t.tasks.actions.cancel);
    expect(html).toContain('Task completed');
    expect(html).toContain('Run production check');
    expect(html).not.toContain('internal');
  });

  it('renders an empty state without scheduled tasks', () => {
    const html = renderToStaticMarkup(
      createElement(TaskPanel, { ...baseProps, tasks: [] }),
    );

    expect(html).toContain(t.tasks.empty);
  });
});
