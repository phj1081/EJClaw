import { describe, expect, it } from 'vitest';

import { _initTestDatabase, insertPairedTurnOutput } from './db.js';
import { requireDatabase } from './db/runtime-database.js';
import {
  normalizeDbEvidenceLimit,
  normalizeDbEvidenceMinutes,
  normalizeDbEvidenceTaskId,
  runDbEvidenceRequest,
} from './db-evidence.js';

describe('DB evidence presets', () => {
  function seedPairedTask(): void {
    _initTestDatabase();
    requireDatabase()
      .prepare(
        `
          INSERT INTO paired_tasks (
            id, chat_jid, group_folder, owner_service_id, reviewer_service_id,
            owner_agent_type, reviewer_agent_type, arbiter_agent_type,
            status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        'task-1',
        'room-1',
        'room-folder',
        'codex-main',
        'claude',
        'codex',
        'claude-code',
        'codex',
        'active',
        '2026-05-26T00:00:00.000Z',
        '2026-05-26T00:10:00.000Z',
      );
    requireDatabase()
      .prepare(
        `
          INSERT INTO paired_turns (
            turn_id, task_id, task_updated_at, role, intent_kind, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        'turn-1',
        'task-1',
        '2026-05-26T00:10:00.000Z',
        'owner',
        'owner-turn',
        '2026-05-26T00:00:01.000Z',
        '2026-05-26T00:00:02.000Z',
      );
    requireDatabase()
      .prepare(
        `
          INSERT INTO paired_turn_attempts (
            attempt_id, turn_id, attempt_no, task_id, task_updated_at, role, intent_kind,
            state, executor_service_id, executor_agent_type, active_run_id,
            created_at, updated_at, completed_at, last_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        'turn-1:attempt:1',
        'turn-1',
        1,
        'task-1',
        '2026-05-26T00:10:00.000Z',
        'owner',
        'owner-turn',
        'failed',
        'codex-main',
        'codex',
        null,
        '2026-05-26T00:00:01.000Z',
        '2026-05-26T00:00:03.000Z',
        '2026-05-26T00:00:04.000Z',
        'failure with sk-12345678901234567890',
      );
    insertPairedTurnOutput(
      'task-1',
      1,
      'owner',
      'SECRET USER TEXT SHOULD NOT BE RETURNED',
      '2026-05-26T00:00:05.000Z',
    );
    requireDatabase()
      .prepare(
        `
          INSERT INTO work_items (
            group_folder, chat_jid, agent_type, service_id, delivery_role,
            status, start_seq, end_seq, result_payload, delivery_attempts,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        'room-folder',
        'room-1',
        'codex',
        'codex-main',
        'owner',
        'produced',
        null,
        null,
        'raw delivery body should not be returned',
        0,
        '2026-05-26T00:00:06.000Z',
        '2026-05-26T00:00:06.000Z',
      );
  }

  it('normalizes request bounds and validates task ids', () => {
    expect(normalizeDbEvidenceMinutes()).toBe(60);
    expect(normalizeDbEvidenceMinutes(0)).toBe(1);
    expect(normalizeDbEvidenceMinutes(99999)).toBe(1440);
    expect(normalizeDbEvidenceLimit()).toBe(20);
    expect(normalizeDbEvidenceLimit(999)).toBe(100);
    expect(normalizeDbEvidenceTaskId(' task-1 ')).toBe('task-1');
    expect(() => normalizeDbEvidenceTaskId('../bad task')).toThrow(
      'Unsupported paired task id',
    );
  });

  it('returns task status and flow metadata without raw bodies', () => {
    seedPairedTask();

    const status = JSON.parse(
      runDbEvidenceRequest(
        requireDatabase(),
        { action: 'db_paired_task_status', taskId: 'task-1' },
        { sourceGroup: 'room-folder', isMain: false },
      ),
    ) as { task: { id: string; group_folder: string } };
    expect(status.task.id).toBe('task-1');
    expect(status.task.group_folder).toBe('room-folder');

    const flowText = runDbEvidenceRequest(
      requireDatabase(),
      { action: 'db_paired_task_flow', taskId: 'task-1' },
      { sourceGroup: 'room-folder', isMain: false },
    );
    expect(flowText).toContain('"output_chars"');
    expect(flowText).toContain('"last_error_chars"');
    expect(flowText).not.toContain('SECRET USER TEXT');
    expect(flowText).not.toContain('raw delivery body');
    expect(flowText).not.toContain('sk-12345678901234567890');
  });

  it('scopes non-main DB evidence to the source group', () => {
    seedPairedTask();

    const blocked = JSON.parse(
      runDbEvidenceRequest(
        requireDatabase(),
        { action: 'db_paired_task_status', taskId: 'task-1' },
        { sourceGroup: 'other-folder', isMain: false },
      ),
    ) as { task: unknown };
    expect(blocked.task).toBeNull();

    const main = JSON.parse(
      runDbEvidenceRequest(
        requireDatabase(),
        { action: 'db_paired_task_status', taskId: 'task-1' },
        { sourceGroup: 'other-folder', isMain: true },
      ),
    ) as { task: { id: string } };
    expect(main.task.id).toBe('task-1');
  });
});
