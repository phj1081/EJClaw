import { describe, expect, it } from 'vitest';

import type { StatusSnapshot } from './status-dashboard.js';
import type { ScheduledTask } from './types.js';
import {
  buildWebDashboardOverview,
  sanitizeScheduledTask,
} from './web-dashboard-data.js';

function makeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'general',
    chat_jid: 'dc:general',
    agent_type: null,
    status_message_id: null,
    status_started_at: null,
    prompt: 'secret long prompt that should not be exposed in full',
    schedule_type: 'cron',
    schedule_value: '* * * * *',
    context_mode: 'group',
    next_run: '2026-04-26T05:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-04-26T04:00:00.000Z',
    ...overrides,
  };
}

describe('web dashboard data', () => {
  it('builds overview counts from status snapshots and scheduled tasks', () => {
    const snapshots: StatusSnapshot[] = [
      {
        serviceId: 'codex-main',
        agentType: 'codex',
        assistantName: 'Codex',
        updatedAt: '2026-04-26T04:59:00.000Z',
        entries: [
          {
            jid: 'dc:1',
            name: '#general',
            folder: 'general',
            agentType: 'codex',
            status: 'processing',
            elapsedMs: 1200,
            pendingMessages: true,
            pendingTasks: 2,
          },
          {
            jid: 'dc:2',
            name: '#brain',
            folder: 'brain',
            agentType: 'claude-code',
            status: 'inactive',
            elapsedMs: null,
            pendingMessages: false,
            pendingTasks: 0,
          },
        ],
        usageRows: [
          {
            name: 'codex-a',
            h5pct: 10,
            h5reset: '1h',
            d7pct: 20,
            d7reset: '2d',
          },
        ],
      },
    ];

    const overview = buildWebDashboardOverview({
      now: '2026-04-26T05:00:00.000Z',
      snapshots,
      tasks: [
        makeTask({
          id: 'watch-1',
          prompt: '[BACKGROUND CI WATCH] owner/repo#1',
          status: 'active',
        }),
        makeTask({ id: 'cron-1', prompt: 'regular cleanup', status: 'paused' }),
      ],
    });

    expect(overview.rooms.total).toBe(2);
    expect(overview.rooms.active).toBe(1);
    expect(overview.rooms.waiting).toBe(0);
    expect(overview.rooms.inactive).toBe(1);
    expect(overview.tasks.total).toBe(2);
    expect(overview.tasks.active).toBe(1);
    expect(overview.tasks.paused).toBe(1);
    expect(overview.tasks.watchers.active).toBe(1);
    expect(overview.usage.rows).toHaveLength(1);
  });

  it('does not expose full scheduled task prompts through API payloads', () => {
    const sanitized = sanitizeScheduledTask(
      makeTask({
        prompt: 'x'.repeat(220),
        last_result: 'ok',
      }),
    );

    expect(sanitized).not.toHaveProperty('prompt');
    expect(sanitized.promptPreview.length).toBeLessThanOrEqual(123);
    expect(sanitized.promptLength).toBe(220);
  });

  it('redacts common secret values from scheduled task prompt previews', () => {
    const sanitized = sanitizeScheduledTask(
      makeTask({
        prompt:
          'deploy with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456 and BOT_TOKEN=plain-secret-value',
      }),
    );

    expect(sanitized.promptPreview).toContain('OPENAI_API_KEY=<redacted>');
    expect(sanitized.promptPreview).toContain('BOT_TOKEN=<redacted>');
    expect(sanitized.promptPreview).not.toContain(
      'sk-abcdefghijklmnopqrstuvwxyz123456',
    );
    expect(sanitized.promptPreview).not.toContain('plain-secret-value');
  });
});
