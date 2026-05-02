import { describe, expect, it } from 'vitest';

import type { StatusSnapshot } from './status-dashboard.js';
import type { PairedTask, ScheduledTask } from './types.js';
import {
  handleOverviewRoute,
  type OverviewRouteDependencies,
} from './web-dashboard-overview-routes.js';
import type { ServiceRestartRecord } from './web-dashboard-service-routes.js';

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

function makeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'ops',
    chat_jid: 'dc:ops',
    agent_type: null,
    status_message_id: null,
    status_started_at: null,
    prompt: 'run task',
    schedule_type: 'once',
    schedule_value: '2026-04-26T05:20:00.000Z',
    context_mode: 'isolated',
    next_run: '2026-04-26T05:20:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    suspended_until: null,
    created_at: '2026-04-26T05:00:00.000Z',
    ...overrides,
  };
}

function makePairedTask(overrides: Partial<PairedTask>): PairedTask {
  return {
    id: 'paired-1',
    chat_jid: 'dc:ops',
    group_folder: 'ops',
    owner_service_id: 'codex-main',
    reviewer_service_id: 'claude-reviewer',
    owner_agent_type: 'codex',
    reviewer_agent_type: 'claude-code',
    arbiter_agent_type: 'codex',
    title: 'Review dashboard',
    source_ref: null,
    plan_notes: null,
    review_requested_at: null,
    round_trip_count: 0,
    owner_failure_count: 0,
    owner_step_done_streak: 0,
    finalize_step_done_count: 0,
    task_done_then_user_reopen_count: 0,
    empty_step_done_streak: 0,
    status: 'review_ready',
    arbiter_verdict: null,
    arbiter_requested_at: null,
    completion_reason: null,
    created_at: '2026-04-26T04:00:00.000Z',
    updated_at: '2026-04-26T05:00:00.000Z',
    ...overrides,
  };
}

function route(
  pathname: string,
  overrides: Partial<OverviewRouteDependencies> = {},
): Response | null {
  return handleOverviewRoute({
    url: new URL(`http://localhost${pathname}`),
    jsonResponse,
    loadPairedTasks: () => [],
    loadTasks: () => [],
    readSnapshots: () => [],
    recentServiceRestarts: [],
    statusMaxAgeMs: 1234,
    now: () => '2026-04-26T05:10:00.000Z',
    ...overrides,
  });
}

describe('web dashboard overview route', () => {
  it('serves overview JSON with operation restart records', async () => {
    const recentServiceRestarts: ServiceRestartRecord[] = [
      {
        id: 'web-restart-1',
        target: 'stack',
        requestedAt: '2026-04-26T05:00:00.000Z',
        completedAt: '2026-04-26T05:00:01.000Z',
        status: 'success',
        services: ['ejclaw'],
      },
    ];
    const response = route('/api/overview', {
      loadTasks: () => [makeTask({ id: 'task-active' })],
      recentServiceRestarts,
    });

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      generatedAt: '2026-04-26T05:10:00.000Z',
      tasks: { total: 1, active: 1 },
      operations: {
        serviceRestarts: [
          {
            id: 'web-restart-1',
            status: 'success',
            services: ['ejclaw'],
          },
        ],
      },
    });
  });

  it('filters dismissed inbox items and falls through for other paths', async () => {
    const snapshots: StatusSnapshot[] = [
      {
        serviceId: 'codex-main',
        agentType: 'codex',
        assistantName: 'Codex',
        updatedAt: '2026-04-26T05:00:00.000Z',
        entries: [
          {
            jid: 'dc:ops',
            name: '#ops',
            folder: 'ops',
            agentType: 'codex',
            status: 'waiting',
            elapsedMs: 2500,
            pendingMessages: true,
            pendingTasks: 1,
          },
        ],
      },
    ];
    const overview = route('/api/overview', {
      loadPairedTasks: () => [
        makePairedTask({ id: 'merge-1', status: 'merge_ready' }),
      ],
      readSnapshots: () => snapshots,
      isInboxItemDismissed: () => true,
    });

    expect(overview?.status).toBe(200);
    await expect(overview?.json()).resolves.toMatchObject({ inbox: [] });

    const unmatched = route('/api/tasks');
    expect(unmatched).toBeNull();
  });
});
