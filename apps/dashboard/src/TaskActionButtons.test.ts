import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DashboardTask } from './api';
import { messages } from './i18n';
import { TaskActionButtons } from './TaskActionButtons';

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
  lastResult: null,
  lastRun: null,
  nextRun: '2026-04-28T05:00:00.000Z',
  promptLength: 42,
  promptPreview: 'Run production check',
  scheduleType: 'interval',
  scheduleValue: '10m',
  status: 'active',
  suspendedUntil: null,
};

describe('TaskActionButtons', () => {
  it('renders task actions with shared busy state styling', () => {
    const html = renderToStaticMarkup(
      createElement(TaskActionButtons, {
        className: 'inbox-actions',
        onTaskAction: () => {},
        task,
        taskActionKey: 'task-1:pause',
        t,
      }),
    );

    expect(html).toContain('task-actions inbox-actions');
    expect(html).toContain('task-action task-action-pause is-busy');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(t.tasks.actions.busy);
    expect(html).toContain(t.tasks.actions.cancel);
  });
});
