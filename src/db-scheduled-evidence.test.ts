import { describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import { requireDatabase } from './db/runtime-database.js';
import { runDbEvidenceRequest } from './db-evidence.js';

function seedScheduledTaskEvidence(): void {
  _initTestDatabase();
  const now = new Date().toISOString();
  requireDatabase()
    .prepare(
      `
        INSERT INTO scheduled_tasks (
          id, group_folder, chat_jid, agent_type, room_role, ci_provider,
          ci_metadata, max_duration_ms, status_message_id, status_started_at,
          prompt, schedule_type, schedule_value, context_mode, next_run,
          last_run, last_result, status, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      'watch-1',
      'room-folder',
      'room-1',
      'codex',
      'owner',
      'github',
      JSON.stringify({
        repo: 'phj1081/EJClaw',
        run_id: 123,
        poll_count: 2,
        consecutive_errors: 1,
        last_checked_at: now,
      }),
      300_000,
      'status-msg-1',
      now,
      '[BACKGROUND CI WATCH]\ntarget=PR #180 checks\nSECRET PROMPT BODY',
      'interval',
      '15000',
      'isolated',
      now,
      now,
      'raw CI result body',
      'active',
      now,
    );
  requireDatabase()
    .prepare(
      `
        INSERT INTO task_run_logs (
          task_id, run_at, duration_ms, status, result, error
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      'watch-1',
      now,
      42,
      'success',
      'raw scheduler result',
      'raw scheduler error',
    );
}

describe('scheduled task DB evidence presets', () => {
  it('returns scheduled task metadata without raw prompt or result bodies', () => {
    seedScheduledTaskEvidence();

    const tasksText = runDbEvidenceRequest(
      requireDatabase(),
      { action: 'db_recent_scheduled_tasks', minutes: 1440 },
      { sourceGroup: 'room-folder', isMain: false },
    );

    expect(tasksText).toContain('"ci_repo": "phj1081/EJClaw"');
    expect(tasksText).toContain('"ci_run_id": 123');
    expect(tasksText).toContain('"status_message_id": "status-msg-1"');
    expect(tasksText).toContain('"prompt_chars"');
    expect(tasksText).toContain('"last_result_chars"');
    expect(tasksText).not.toContain('SECRET PROMPT BODY');
    expect(tasksText).not.toContain('raw CI result body');
  });

  it('returns scheduled run metadata without raw result or error bodies', () => {
    seedScheduledTaskEvidence();

    const runsText = runDbEvidenceRequest(
      requireDatabase(),
      {
        action: 'db_scheduled_task_runs',
        taskId: 'watch-1',
        minutes: 1440,
      },
      { sourceGroup: 'room-folder', isMain: false },
    );

    expect(runsText).toContain('"duration_ms": 42');
    expect(runsText).toContain('"result_chars"');
    expect(runsText).toContain('"error_chars"');
    expect(runsText).not.toContain('raw scheduler result');
    expect(runsText).not.toContain('raw scheduler error');
  });

  it('scopes scheduled task evidence for non-main rooms', () => {
    seedScheduledTaskEvidence();

    const scopedOut = JSON.parse(
      runDbEvidenceRequest(
        requireDatabase(),
        { action: 'db_recent_scheduled_tasks', minutes: 1440 },
        { sourceGroup: 'other-folder', isMain: false },
      ),
    ) as { tasks: unknown[] };

    expect(scopedOut.tasks).toEqual([]);
  });
});
